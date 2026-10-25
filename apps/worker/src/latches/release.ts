/**
 * 保留(candidate)の解放と期限切れ(F4a設計 §3.5・docs/06 §2の(i))。
 * 呼び出し元は提案のクローズ時(関係ユーザー対象)と毎分Cron(全体対象)。
 * Cronは expireHeld(全体の期限切れ)→ releaseHeld(全体の解放)の順に明示的に呼ぶ。
 */

import { LATCH, PIPELINE } from "@latch/shared";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
} from "../db/schema";
import { newUlid } from "../ids";
import { createLogger } from "../logging/logger";
import type { IntentRow } from "../pipeline/consumer";
import { errorCodeOf } from "../pipeline/errors";
import { presentBlockers } from "./caps";
import { closeLatch } from "./close";
import {
	isTooLate,
	minExpiry,
	occasionTargetAt,
	responseDeadline,
} from "./deadline";

type LatchRow = typeof latches.$inferSelect;

const logger = createLogger();

/** 機会の対象時刻(proposal.time_window.start・ISO 8601は文字列順=時刻順) */
const targetStart = sql`json_extract(${latches.proposal}, '$.time_window.start')`;

/** 参加Intentを intent_ids の順で読む。1件でも不在ならnull */
const intentsOf = async (
	db: DrizzleD1Database,
	latch: LatchRow,
): Promise<IntentRow[] | null> => {
	const rows = await db
		.select()
		.from(intents)
		.where(inArray(intents.id, latch.intentIds));
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ordered = latch.intentIds.map((id) => byId.get(id));
	return ordered.every((r) => r !== undefined) ? ordered : null;
};

/**
 * 保留中に参加Intentの期限(latches.expires_at)を過ぎたもの・機会で対象時刻まで75分未満と
 * なったものを、提示せず expired で閉じる(通知なし・proposal_historyはexpired)。戻り値は閉じた件数
 */
export const expireHeld = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<number> => {
	let closed = 0;
	const overdue = await db
		.select({ id: latches.id })
		.from(latches)
		.where(and(eq(latches.status, "candidate"), lte(latches.expiresAt, now)))
		.orderBy(asc(latches.expiresAt), asc(latches.id))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const { id } of overdue) {
		if (
			await closeLatch(
				db,
				id,
				"expired",
				{ kind: "release" },
				["candidate"],
				now,
			)
		) {
			closed++;
		}
	}

	// 機会は対象時刻(proposal.time_window.start=occasionTargetAtと同じ値)が now+75分 より前のものに
	// SQLで先に絞る(参加Intentの読み出しを該当候補に限るための最適化)。判定の正は下のisTooLate
	const leadLimit = new Date(
		now.getTime() + LATCH.OCCASION_MIN_LEAD_MS,
	).toISOString();
	const occasions = await db
		.select()
		.from(latches)
		.where(
			and(
				eq(latches.status, "candidate"),
				eq(latches.form, "occasion"),
				lt(targetStart, leadLimit),
			),
		)
		.orderBy(asc(targetStart), asc(latches.id))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const latch of occasions) {
		const members = await intentsOf(db, latch);
		// 参加Intentが不在のものは releaseHeld が cancelled で閉じる
		if (members === null) continue;
		if (members.some((m) => m.startsAt === null)) continue;
		if (!isTooLate(occasionTargetAt(members), now)) continue;
		if (
			await closeLatch(
				db,
				latch.id,
				"expired",
				{ kind: "release" },
				["candidate"],
				now,
			)
		) {
			closed++;
		}
	}
	return closed;
};

/** candidate → proposed の昇格を1バッチで書く。昇格できたらtrue */
const promote = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	userIds: string[],
	deadline: Date,
	now: Date,
): Promise<boolean> => {
	const nowMs = now.getTime();
	const promoted = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latch.id} AND status = 'proposed' AND proposed_at = ${nowMs} AND updated_at = ${nowMs})`;
	await db.batch([
		db
			.update(latches)
			.set({
				status: "proposed",
				proposedAt: now,
				responseDeadline: deadline,
				updatedAt: now,
			})
			.where(and(eq(latches.id, latch.id), eq(latches.status, "candidate"))),
		db
			.insert(latchStatusEvents)
			.select(
				sql`SELECT ${newUlid()}, ${latch.id}, 'candidate', 'proposed', ${nowMs} WHERE ${promoted}`,
			),
		// 列順の注意: notificationsの末尾3列(intent_id, push_state, push_attempted_at)はマイグレーション0007で追加。INSERT … SELECTは位置で対応するため値の並びを揃える(F7b設計 §2)
		...userIds.map((userId) =>
			db
				.insert(notifications)
				.select(
					sql`SELECT ${newUlid()}, ${userId}, 'proposal', ${latch.id}, NULL, ${nowMs}, NULL, 'pending', NULL WHERE ${promoted}`,
				)
				.onConflictDoNothing(),
		),
	]);
	const [after] = await db
		.select({ status: latches.status, proposedAt: latches.proposedAt })
		.from(latches)
		.where(eq(latches.id, latch.id));
	return after?.status === "proposed" && after.proposedAt?.getTime() === nowMs;
};

/** userIds の照会チャンク幅(D1の1文あたりバインド上限100・他のバインドに余裕を残す) */
const USER_CHUNK = 50;

const chunksOf = <T>(items: T[], size: number): T[][] => {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
};

/** 機会の対象時刻(proposal.time_window.start)。無ければ空文字(先頭へ並ぶ) */
const startOf = (latch: LatchRow): string =>
	(latch.proposal as { time_window?: { start?: string } | null } | null)
		?.time_window?.start ?? "";

/** 走査順: 機会=対象時刻の近い順 → つながり=score降順(同点はid昇順) */
const byReleaseOrder = (x: LatchRow, y: LatchRow): number => {
	if (x.form !== y.form) return x.form === "occasion" ? -1 : 1;
	if (x.form === "occasion") {
		const sx = startOf(x);
		const sy = startOf(y);
		if (sx !== sy) return sx < sy ? -1 : 1;
	} else if (x.score !== y.score) {
		return y.score - x.score;
	}
	return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
};

/** 走査対象の保留を読む。userIds 指定時はその参加者の保留をチャンク分割で集める */
const heldTargets = async (
	db: DrizzleD1Database,
	userIds: string[] | undefined,
): Promise<LatchRow[]> => {
	const limit = PIPELINE.CRON_BATCH_LIMIT;
	if (userIds !== undefined) {
		const byId = new Map<string, LatchRow>();
		for (const chunk of chunksOf([...new Set(userIds)], USER_CHUNK)) {
			const rows = await db
				.select()
				.from(latches)
				.where(
					and(
						eq(latches.status, "candidate"),
						inArray(
							latches.id,
							db
								.select({ id: latchMembers.latchId })
								.from(latchMembers)
								.where(inArray(latchMembers.userId, chunk)),
						),
					),
				)
				.limit(limit);
			for (const row of rows) byId.set(row.id, row);
		}
		return [...byId.values()].sort(byReleaseOrder).slice(0, limit);
	}
	const occasions = await db
		.select()
		.from(latches)
		.where(and(eq(latches.status, "candidate"), eq(latches.form, "occasion")))
		.orderBy(asc(targetStart), asc(latches.id))
		.limit(limit);
	const connections =
		occasions.length < limit
			? await db
					.select()
					.from(latches)
					.where(
						and(
							eq(latches.status, "candidate"),
							eq(latches.form, "connection"),
						),
					)
					.orderBy(desc(latches.score), asc(latches.id))
					.limit(limit - occasions.length)
			: [];
	return [...occasions, ...connections];
};

/** 意思・参加者の行のまとめ読みのチャンク幅(D1の1文あたりバインド上限100の手前) */
const ID_CHUNK = 90;

/** 走査の前にまとめて読んだ行(#45: 1件ずつの往復をやめる) */
interface Prefetched {
	intentById: Map<string, IntentRow>;
	membersByLatch: Map<string, string[]>;
}

/**
 * 対象の全保留の参加Intentの行と参加者の行を、走査の前にまとめて読む(チャンク分割)。
 * 走査中の書き込み(closeLatch・promote)はどちらの行も変えないため、読んだ値は走査の終わりまで使える
 */
const prefetch = async (
	db: DrizzleD1Database,
	targets: LatchRow[],
): Promise<Prefetched> => {
	const intentById = new Map<string, IntentRow>();
	const intentIds = [...new Set(targets.flatMap((l) => l.intentIds))];
	for (const chunk of chunksOf(intentIds, ID_CHUNK)) {
		const rows = await db
			.select()
			.from(intents)
			.where(inArray(intents.id, chunk));
		for (const row of rows) intentById.set(row.id, row);
	}
	const membersByLatch = new Map<string, string[]>();
	for (const chunk of chunksOf(
		targets.map((l) => l.id),
		ID_CHUNK,
	)) {
		const rows = await db
			.select({ latchId: latchMembers.latchId, userId: latchMembers.userId })
			.from(latchMembers)
			.where(inArray(latchMembers.latchId, chunk));
		for (const row of rows) {
			const list = membersByLatch.get(row.latchId) ?? [];
			list.push(row.userId);
			membersByLatch.set(row.latchId, list);
		}
	}
	return { intentById, membersByLatch };
};

/** 参加Intentを intent_ids の順で返す。1件でも不在ならnull(intentsOfと同じ判定) */
const intentsFrom = (pre: Prefetched, latch: LatchRow): IntentRow[] | null => {
	const ordered = latch.intentIds.map((id) => pre.intentById.get(id));
	return ordered.every((r) => r !== undefined) ? ordered : null;
};

/**
 * 走査中に提示の上限に届いたと分かった利用者・意思。どちらの数(当日の提案の通知・進行中の提案)も
 * 走査の中の昇格では増える一方のため、これらを含む後続の保留は照会せずに保留のまま残してよい(#45)
 */
interface CappedSets {
	userIds: Set<string>;
	intentIds: Set<string>;
}

/**
 * 保留1件を処理する(期限処理・取り消し・昇格)。昇格したらtrue
 */
const releaseOne = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	now: Date,
	pre: Prefetched,
	capped: CappedSets,
): Promise<boolean> => {
	if (latch.expiresAt.getTime() <= now.getTime()) {
		await closeLatch(
			db,
			latch.id,
			"expired",
			{ kind: "release" },
			["candidate"],
			now,
		);
		return false;
	}
	const intentRows = intentsFrom(pre, latch);
	if (
		latch.form === "occasion" &&
		intentRows !== null &&
		intentRows.every((i) => i.startsAt !== null) &&
		isTooLate(occasionTargetAt(intentRows), now)
	) {
		await closeLatch(
			db,
			latch.id,
			"expired",
			{ kind: "release" },
			["candidate"],
			now,
		);
		return false;
	}
	if (
		intentRows === null ||
		intentRows.some(
			(i) =>
				i.status === "matched" ||
				i.status === "expired" ||
				i.status === "cancelled",
		)
	) {
		await closeLatch(
			db,
			latch.id,
			"cancelled",
			{ kind: "release" },
			["candidate"],
			now,
		);
		return false;
	}
	// paused(と想定外の状態)は保留のまま残す
	if (intentRows.some((i) => i.status !== "active")) return false;

	const memberIds = pre.membersByLatch.get(latch.id) ?? [];
	// 上限に届いたと分かっている利用者・意思を含む保留は、照会せずに保留のまま残す(判定の結果は照会と同じ)
	if (
		memberIds.some((id) => capped.userIds.has(id)) ||
		latch.intentIds.some((id) => capped.intentIds.has(id))
	) {
		return false;
	}
	const blockers = await presentBlockers(db, memberIds, latch.intentIds, now);
	if (blockers.userIds.length > 0 || blockers.intentIds.length > 0) {
		for (const id of blockers.userIds) capped.userIds.add(id);
		for (const id of blockers.intentIds) capped.intentIds.add(id);
		return false;
	}

	const targetAt =
		latch.form === "occasion" ? occasionTargetAt(intentRows) : null;
	const deadline = responseDeadline(
		latch.form,
		now,
		targetAt,
		minExpiry(intentRows),
	);
	return promote(db, latch, memberIds, deadline, now);
};

/**
 * 保留(candidate)を順に走査し、提示の上限(F4a設計 §3.3)を満たすものを proposed へ昇格する。
 * 順序: 機会=対象時刻の近い順 → つながり=score降順(同点はid昇順)。1回の走査は最大500件。
 * 走査中の期限処理は対象範囲内だけで行う: 期限(latches.expires_at)到達・機会で対象時刻まで
 * 75分未満のものは昇格させず expired で閉じる(全体の期限切れは Cron が expireHeld で先に閉じる)。
 * 参加Intentが matched・expired・cancelled・不在なら cancelled で閉じ(排他の取りこぼしの安全網)、
 * paused なら保留のまま残す(pauseは提案を継続する・docs/06 §2)。
 * 参加Intentと参加者の行は走査の前にまとめて読み、上限に届いた利用者・意思を含む後続の保留は
 * 照会を省く(#45)。opts.budgetMs を渡すと、読み出しからの経過がそれに達した時点で残りを処理せずに
 * 返す(残りは candidate のまま毎分Cronの releaseHeld が拾う)。
 * userIds 指定時はその参加者の保留のみを対象とする。戻り値は昇格した件数
 */
export const releaseHeld = async (
	db: DrizzleD1Database,
	now: Date,
	userIds?: string[],
	opts?: { budgetMs?: number },
): Promise<number> => {
	if (userIds !== undefined && userIds.length === 0) return 0;

	// 所要時間の計測のため performance.now() を使う(時刻の判定は now で行う)
	const startedAt = performance.now();
	const targets = await heldTargets(db, userIds);
	const pre = await prefetch(db, targets);
	const capped: CappedSets = { userIds: new Set(), intentIds: new Set() };
	let released = 0;
	for (const [index, latch] of targets.entries()) {
		if (
			opts?.budgetMs !== undefined &&
			performance.now() - startedAt >= opts.budgetMs
		) {
			logger.info("release.budget_exhausted", {
				layer: "release_held",
				count: targets.length - index,
			});
			break;
		}
		// 1件の失敗で走査全体を止めない(latch_id・error_codeのみをログ・docs/08 §6)
		try {
			if (await releaseOne(db, latch, now, pre, capped)) released++;
		} catch (error) {
			logger.warn("cron.item.failed", {
				layer: "release_held",
				latch_id: latch.id,
				error_code: errorCodeOf(error),
			});
		}
	}
	return released;
};
