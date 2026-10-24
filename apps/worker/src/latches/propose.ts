/**
 * 提案化(F4a設計 §3.2〜§3.4・§3.6・F4b設計 §3.1)。2〜4人の集合を扱い、1対1は2人の集合と同じ経路を通る。
 * proposal_history(UNIQUE(user_low,user_high)の1ペア1行)の全ペア(C(n,2)行)の確保を
 * バッチの先頭に並べ、後続の書き込みをすべて「latch_id=新idの履歴行の数=C(n,2)」で
 * 条件付けた1つのD1バッチ(1トランザクション)で書く。並行した提案化は履歴確保で1件に絞られ、
 * 一部のペアだけ確保できた側は、同じバッチ末尾の補償文が確保分を巻き戻すため何も残らない。
 * 同じ条件に「参加者のどの2人の間にもblocks行が無いこと」を含め、ブロックがあれば同様に
 * 何も作らず巻き戻す(F7a設計 §2.4)。
 */
import { LATCH } from "@latch/shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	groupCandidates,
	latches,
	latchMembers,
	latchStatusEvents,
	matchCandidates,
	notifications,
	proposalHistory,
} from "../db/schema";
import { newUlid } from "../ids";
import type { IntentRow } from "../pipeline/consumer";
import { intentPairKey } from "../pipeline/group";
import { pairKey } from "../pipeline/layer1";
import { canPresent } from "./caps";
import { baseIntentOf, buildProposal } from "./content";
import {
	isTooLate,
	minExpiry,
	occasionTargetAt,
	responseDeadline,
} from "./deadline";
import { lookupRegionName } from "./region";

export type ProposeOutcome = "proposed" | "held" | "skipped";

/** 提案化の起点となった候補行(F4b設計 §3.1) */
export type ProposeSource =
	| { kind: "pair"; rowId: string } // match_candidates.id
	| { kind: "group"; groupCandidateId: string }; // group_candidates.id

export interface ProposeSetInput {
	/** 2〜4人・id昇順 */
	members: IntentRow[];
	/** 1対1=Layer 5のL・集合=aggregate(latches.scoreへ) */
	score: number;
	source: ProposeSource;
}

type HistoryRow = typeof proposalHistory.$inferSelect;

/** 前回LATCH(既存履歴行のlatch_idが指す行)のscoreとcreated_at */
const prevLatchOf = async (
	db: DrizzleD1Database,
	latchId: string | null,
): Promise<{ score: number; createdAt: Date } | null> => {
	if (latchId === null) return null;
	const [row] = await db
		.select({ score: latches.score, createdAt: latches.createdAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	return row ?? null;
};

type HistoryOutcome = typeof proposalHistory.$inferSelect.outcome;

/**
 * 既存の提案履歴がある同ペアへ再提案し得るか(docs/01 §8・docs/06 §4)。
 * つながり(targetAt=null)は既存行があれば一切再提案しない。機会もdeferred/expired以外は不可
 */
export const historyAllowsReproposal = (
	outcome: HistoryOutcome,
	targetAt: Date | null,
): boolean =>
	targetAt !== null && (outcome === "deferred" || outcome === "expired");

/** 抑制期間中か: now < updated_at + min(24時間, (対象時刻 - updated_at)/2)(docs/01 §8) */
export const isReproposalSuppressed = (
	historyUpdatedAt: Date,
	targetAt: Date,
	now: Date,
): boolean => {
	const since = historyUpdatedAt.getTime();
	const suppression = Math.min(
		LATCH.REPROPOSAL_SUPPRESSION_MAX_MS,
		(targetAt.getTime() - since) / 2,
	);
	return now.getTime() < since + suppression;
};

/**
 * 既存の履歴行1件がこの時点の提案を妨げるか(ペア1件の判定・blockedForProposalと
 * historyBlockedPairsで共通)。再提案不可、または機会で抑制期間中なら妨げる
 */
const historyBlocks = (
	history: { outcome: HistoryOutcome; updatedAt: Date },
	targetAt: Date | null,
	now: Date,
): boolean =>
	!historyAllowsReproposal(history.outcome, targetAt) ||
	(targetAt !== null &&
		isReproposalSuppressed(history.updatedAt, targetAt, now));

/** 照会のチャンク幅(user_low/user_highの2方向で2×48+α件のバインド・docs/06 §3の48件) */
const PAIR_CHUNK_SIZE = 48;

/**
 * 履歴によりこの時点で提案できない相手Intentのid集合を返す(Layer 4の前の除外・docs/06 §5)。
 * 判定は proposeSet の履歴判定と同じ(既存行あり かつ 再提案不可、または抑制期間中)。
 * スコア変化・Intent更新の条件はJev後のスコアに依るためここでは見ない(proposeSetが判定する)。
 * Layer 1の恒久排除(matched・rejected)とは別に数える。照会は相手ユーザー48件のチャンク
 */
export const blockedForProposal = async (
	db: DrizzleD1Database,
	origin: IntentRow,
	others: IntentRow[],
	now: Date,
): Promise<Set<string>> => {
	const blocked = new Set<string>();
	const otherUserIds = [...new Set(others.map((o) => o.userId))];
	const historyByUser = new Map<
		string,
		{ outcome: HistoryOutcome; updatedAt: Date }
	>();
	// チャンクは互いに依存しないため同時に投げる(#36)
	const chunks: string[][] = [];
	for (let i = 0; i < otherUserIds.length; i += PAIR_CHUNK_SIZE) {
		chunks.push(otherUserIds.slice(i, i + PAIR_CHUNK_SIZE));
	}
	const results = await Promise.all(
		chunks.map((chunk) =>
			db
				.select({
					userLow: proposalHistory.userLow,
					userHigh: proposalHistory.userHigh,
					outcome: proposalHistory.outcome,
					updatedAt: proposalHistory.updatedAt,
				})
				.from(proposalHistory)
				.where(
					or(
						and(
							eq(proposalHistory.userLow, origin.userId),
							inArray(proposalHistory.userHigh, chunk),
						),
						and(
							eq(proposalHistory.userHigh, origin.userId),
							inArray(proposalHistory.userLow, chunk),
						),
					),
				),
		),
	);
	for (const row of results.flat()) {
		const other = row.userLow === origin.userId ? row.userHigh : row.userLow;
		historyByUser.set(other, {
			outcome: row.outcome,
			updatedAt: row.updatedAt,
		});
	}
	for (const other of others) {
		const history = historyByUser.get(other.userId);
		if (history === undefined) continue;
		if (
			origin.form === "occasion" &&
			(origin.startsAt === null || other.startsAt === null)
		) {
			// 不変条件違反(activeの機会はstarts_at必須)。判定はproposeSetに委ねる
			continue;
		}
		const targetAt =
			origin.form === "occasion" ? occasionTargetAt([origin, other]) : null;
		if (historyBlocks(history, targetAt, now)) {
			blocked.add(other.id);
		}
	}
	return blocked;
};

/**
 * ユーザー集合の内部の全ペアの履歴行を、ユーザーペアキー(pairKey)で引ける形で返す。
 * 行は low < high に正規化済みのため、low・highの両方が集合に入る行だけを読む。
 * 照会はlow・highそれぞれ48件のチャンク(1文のバインドは2×48件)
 */
const historiesAmongUsers = async (
	db: DrizzleD1Database,
	userIds: string[],
): Promise<Map<string, HistoryRow>> => {
	const ids = [...new Set(userIds)];
	// low・highのチャンクの組は互いに依存しないため同時に投げる(#36)
	const reads: Promise<HistoryRow[]>[] = [];
	for (let i = 0; i < ids.length; i += PAIR_CHUNK_SIZE) {
		const lows = ids.slice(i, i + PAIR_CHUNK_SIZE);
		for (let j = 0; j < ids.length; j += PAIR_CHUNK_SIZE) {
			const highs = ids.slice(j, j + PAIR_CHUNK_SIZE);
			reads.push(
				db
					.select()
					.from(proposalHistory)
					.where(
						and(
							inArray(proposalHistory.userLow, lows),
							inArray(proposalHistory.userHigh, highs),
						),
					),
			);
		}
	}
	const out = new Map<string, HistoryRow>();
	for (const row of (await Promise.all(reads)).flat()) {
		out.set(pairKey(row.userLow, row.userHigh), row);
	}
	return out;
};

/** メンバーの順序なしペア(i < j)の列挙 */
const pairsOf = (members: IntentRow[]): [IntentRow, IntentRow][] => {
	const out: [IntentRow, IntentRow][] = [];
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			out.push([members[i], members[j]]);
		}
	}
	return out;
};

/**
 * 履歴によりこの時点で提案できないペア(intentPairKey)。判定はblockedForProposalと同じ規則
 * (ペアごとの対象時刻で、既存行あり かつ 再提案不可、または抑制期間中)。
 * スコア変化・Intent更新の条件はここでは見ない(proposeSetが判定する・F4b設計 §3.1)。
 * 抑制期間はペアごとの対象時刻で判定する緩い事前除外であり、正はproposeSetが集合の対象時刻
 * (全メンバーのstarts_atの最大値)で行う再判定
 */
export const historyBlockedPairs = async (
	db: DrizzleD1Database,
	members: IntentRow[],
	now: Date,
): Promise<Set<string>> => {
	const blocked = new Set<string>();
	const histories = await historiesAmongUsers(
		db,
		members.map((m) => m.userId),
	);
	for (const [p, q] of pairsOf(members)) {
		const history = histories.get(pairKey(p.userId, q.userId));
		if (history === undefined) continue;
		if (p.form === "occasion" && (p.startsAt === null || q.startsAt === null)) {
			// 不変条件違反(activeの機会はstarts_at必須)。判定はproposeSetに委ねる
			continue;
		}
		const targetAt = p.form === "occasion" ? occasionTargetAt([p, q]) : null;
		if (historyBlocks(history, targetAt, now)) {
			blocked.add(intentPairKey(p.id, q.id));
		}
	}
	return blocked;
};

/** 再提案判定用に前回LATCHのscoreを起点の候補行へ記録する(F4b設計 §3.1) */
const recordPrevScore = async (
	db: DrizzleD1Database,
	source: ProposeSource,
	prevScore: number,
): Promise<void> => {
	if (source.kind === "pair") {
		await db
			.update(matchCandidates)
			.set({ prevLatchScore: prevScore })
			.where(eq(matchCandidates.id, source.rowId));
	} else {
		await db
			.update(groupCandidates)
			.set({ prevAggregateScore: prevScore })
			.where(eq(groupCandidates.id, source.groupCandidateId));
	}
};

export const proposeSet = async (
	db: DrizzleD1Database,
	input: ProposeSetInput,
	now: Date,
): Promise<ProposeOutcome> => {
	const { members, score, source } = input;
	if (members.length < 2 || members.length > 4) {
		throw new Error("proposal set size out of range");
	}
	const form = members[0].form;
	if (form === null) throw new Error("proposal intent without form");
	const targetAt = form === "occasion" ? occasionTargetAt(members) : null;

	// 1. 機会で対象時刻まで75分未満なら提案しない(docs/01 §8)
	if (targetAt !== null && isTooLate(targetAt, now)) return "skipped";

	// 2〜3の読み込み(全ペアの履歴・提示か保留かの上限・地名)は互いに依存しないため同時に投げる
	// (D1の直列の待ちを1段にする・#36)。履歴で提案しないと決まる場合も上限と地名は読むが、
	// 読むだけで何も書かない。上限の判定と書き込みは元から同一文ではない(caps.ts・設計 §3.3)
	const base = baseIntentOf(members);
	const [histories, present, regionName] = await Promise.all([
		// 2. 全ペアの既存の提案履歴(ペア単位・low < high に正規化)
		historiesAmongUsers(
			db,
			members.map((m) => m.userId),
		),
		// 3. 提示か保留か(F4a設計 §3.3をn人へ拡張・F4b設計 §3.1)
		canPresent(
			db,
			members.map((m) => m.userId),
			members.map((m) => m.id),
			now,
		),
		base.geoCenterLat !== null &&
		base.geoCenterLng !== null &&
		base.geoRadiusM !== null
			? lookupRegionName(db, {
					lat: base.geoCenterLat,
					lng: base.geoCenterLng,
				})
			: Promise.resolve(null),
	]);
	const pairs = pairsOf(members).map(([p, q]) => {
		const [userLow, userHigh] =
			p.userId < q.userId ? [p.userId, q.userId] : [q.userId, p.userId];
		return {
			userLow,
			userHigh,
			existing: histories.get(pairKey(userLow, userHigh)),
		};
	});
	const existingRows = pairs.flatMap((pair) =>
		pair.existing === undefined ? [] : [pair.existing],
	);
	// 1ペアでも再提案不可(進行中・成立・拒否・つながりの既存行)なら提案しない(F4b設計 §3.6)
	if (existingRows.some((r) => !historyAllowsReproposal(r.outcome, targetAt))) {
		return "skipped";
	}
	if (existingRows.length > 0) {
		// 前回LATCHの読み込みは行ごとに独立のため同時に投げる(#36)
		const prevs = await Promise.all(
			existingRows.map((r) => prevLatchOf(db, r.latchId)),
		);
		// 再提案判定用に最も新しい前回LATCHのscoreを記録する(再提案でもスキップでも)
		let latest: { score: number; createdAt: Date } | null = null;
		for (const prev of prevs) {
			if (
				prev !== null &&
				(latest === null ||
					prev.createdAt.getTime() > latest.createdAt.getTime())
			) {
				latest = prev;
			}
		}
		if (latest !== null) await recordPrevScore(db, source, latest.score);
		if (
			targetAt === null ||
			existingRows.some((r) =>
				isReproposalSuppressed(r.updatedAt, targetAt, now),
			)
		) {
			return "skipped";
		}
		for (const prev of prevs) {
			// 前回LATCHが無い場合は変化の有無を判定できないため再提案しない
			if (prev === null) return "skipped";
			const changed =
				prev.score !== score ||
				members.some((m) => m.updatedAt.getTime() > prev.createdAt.getTime());
			if (!changed) return "skipped";
		}
	}

	const proposal = buildProposal(members, regionName);
	const expiresAt = minExpiry(members);
	const status = present ? "proposed" : "candidate";
	// 保留中の回答期限は暫定でexpires_at(提示時に計算し直す・F4a設計 §3.5)
	const deadline = present
		? responseDeadline(form, now, targetAt, expiresAt)
		: expiresAt;
	const latchId = newUlid();
	const nowMs = now.getTime();
	// 全ペアの両方向(ブロックはどちらの向きでも提案を止める・F7a設計 §2.4)
	const blockPairs = sql.join(
		pairs.flatMap((pair) => [
			sql`(${pair.userLow}, ${pair.userHigh})`,
			sql`(${pair.userHigh}, ${pair.userLow})`,
		]),
		sql`, `,
	);
	// 全ペア(C(n,2)行)を新idで確保できたこと、かつ参加者のどのペアの間にもブロックが無いこと。
	// ブロックの照合をバッチ内の条件に含めるため、読み出しの後にブロックされても提案は作られず、
	// 確保した履歴は末尾の補償文で巻き戻る(F7a設計 §2.4)
	const secured = sql`((SELECT COUNT(*) FROM proposal_history WHERE latch_id = ${latchId}) = ${pairs.length}
		AND NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_user_id, blocked_user_id) IN (VALUES ${blockPairs})))`;
	const notSecured = sql`NOT (${secured})`;

	// 4. 先頭(外部キー検査の遅延指定を除く)=全ペアの履歴の確保。新規は事前に採番したidでINSERT
	// (UNIQUE衝突は何もしない)・再提案は読んだ値を条件とするUPDATE。巻き戻しは事前採番のidと
	// 読み出した値を使う
	const claims: BatchItem<"sqlite">[] = [];
	const compensations: BatchItem<"sqlite">[] = [];
	for (const pair of pairs) {
		const existing = pair.existing;
		if (existing === undefined) {
			const historyId = newUlid();
			claims.push(
				db
					.insert(proposalHistory)
					.values({
						id: historyId,
						userLow: pair.userLow,
						userHigh: pair.userHigh,
						latchId,
						outcome: "proposed",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing({
						target: [proposalHistory.userLow, proposalHistory.userHigh],
					}),
			);
			compensations.push(
				db
					.delete(proposalHistory)
					.where(
						and(
							eq(proposalHistory.id, historyId),
							eq(proposalHistory.latchId, latchId),
							notSecured,
						),
					),
			);
		} else {
			claims.push(
				db
					.update(proposalHistory)
					.set({ outcome: "proposed", latchId, updatedAt: now })
					.where(
						and(
							eq(proposalHistory.id, existing.id),
							inArray(proposalHistory.outcome, ["deferred", "expired"]),
							eq(proposalHistory.updatedAt, existing.updatedAt),
						),
					),
			);
			compensations.push(
				db
					.update(proposalHistory)
					.set({
						outcome: existing.outcome,
						latchId: existing.latchId,
						updatedAt: existing.updatedAt,
					})
					.where(
						and(
							eq(proposalHistory.id, existing.id),
							eq(proposalHistory.latchId, latchId),
							notSecured,
						),
					),
			);
		}
	}

	// 確保の後はすべて全ペアの確保(latch_id=新idの行の数=C(n,2))を条件とする。
	// INSERT … SELECT の列順は各テーブル定義の列順(drizzleのinsert().select())
	const insertLatch = db.insert(latches).select(
		sql`SELECT ${latchId}, ${form}, ${JSON.stringify(members.map((m) => m.id))}, ${JSON.stringify(proposal)}, ${score}, ${status},
			${deadline.getTime()}, ${expiresAt.getTime()}, ${nowMs}, NULL, ${present ? nowMs : null}, ${nowMs}, ${nowMs}
			WHERE ${secured}`,
	);
	// 列数が変わるとSELECTの値の個数が合わなくなる: latch_members(latch_id, user_id, left_at, hidden_at)
	const insertMember = (userId: string) =>
		db
			.insert(latchMembers)
			.select(sql`SELECT ${latchId}, ${userId}, NULL, NULL WHERE ${secured}`);
	const insertEvent = db
		.insert(latchStatusEvents)
		.select(
			sql`SELECT ${newUlid()}, ${latchId}, NULL, ${status}, ${nowMs} WHERE ${secured}`,
		);
	const markSource =
		source.kind === "pair"
			? db
					.update(matchCandidates)
					.set({ status: "proposed", updatedAt: now })
					.where(and(eq(matchCandidates.id, source.rowId), secured))
			: db
					.update(groupCandidates)
					.set({ status: "proposed" })
					.where(and(eq(groupCandidates.id, source.groupCandidateId), secured));
	// 列順の注意: notificationsの末尾3列(intent_id, push_state, push_attempted_at)はマイグレーション0007で追加。INSERT … SELECTは位置で対応するため値の並びを揃える(F7b設計 §2)
	const insertNotification = (userId: string) =>
		db
			.insert(notifications)
			.select(
				sql`SELECT ${newUlid()}, ${userId}, 'proposal', ${latchId}, NULL, ${nowMs}, NULL, 'pending', NULL WHERE ${secured}`,
			);

	const notifyStatements = present
		? members.map((m) => insertNotification(m.userId))
		: [];
	// 5. 全ペアを確保できなかった(並行した別の提案化が先に確保した等)ならLATCHは無い。
	// 確認の読み込みはバッチの末尾に置き、巻き戻しの後の同じトランザクションの状態を読む
	// (別の往復で読まない・#36)
	const createdCheck = db
		.select({ id: latches.id })
		.from(latches)
		.where(eq(latches.id, latchId));
	const results = await db.batch([
		// proposal_history.latch_id → latches.id の外部キー検査をコミット時へ遅らせる
		// (履歴確保を先頭に置くため。D1のバッチは1トランザクションで、終了時に自動で戻る)
		db.run(sql`PRAGMA defer_foreign_keys = ON`),
		...claims,
		insertLatch,
		...members.map((m) => insertMember(m.userId)),
		insertEvent,
		markSource,
		...notifyStatements,
		// 巻き戻し(F4b設計 §3.1): 一部のペアしか確保できなかったときだけ働く。
		// 巻き戻すほど確保数は減るため、途中で条件が反転することはない
		...compensations,
		createdCheck,
	]);
	const created = results[results.length - 1] as { id: string }[];
	if (created.length === 0) return "skipped";
	return present ? "proposed" : "held";
};
