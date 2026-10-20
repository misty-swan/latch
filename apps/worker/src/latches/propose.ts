/**
 * 提案化(F4a設計 §3.2〜§3.4・§3.6)。
 * proposal_history(UNIQUE(user_low,user_high)の1ペア1行)の確保を1文目とし、
 * 後続の書き込みをすべて「latch_id=新idの履歴行が存在すること」で条件付けた
 * 1つのD1バッチ(1トランザクション)で書く。並行した提案化は履歴確保で1件に絞られ、
 * 確保できなかった側の後続は0行となり何も残らない。
 */

import { LATCH } from "@latch/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	latches,
	latchMembers,
	latchStatusEvents,
	matchCandidates,
	notifications,
	proposalHistory,
} from "../db/schema";
import { newUlid } from "../ids";
import type { IntentRow } from "../pipeline/consumer";
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

/** a.id < b.id(match_candidatesの正規化順)。scoreはLayer 5のL */
export interface ProposeInput {
	rowId: string;
	a: IntentRow;
	b: IntentRow;
	score: number;
}

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

export const proposePair = async (
	db: DrizzleD1Database,
	input: ProposeInput,
	now: Date,
): Promise<ProposeOutcome> => {
	const { a, b, rowId, score } = input;
	const form = a.form;
	if (form === null) throw new Error("proposal intent without form");
	const targetAt = form === "occasion" ? occasionTargetAt(a, b) : null;

	// 1. 機会で対象時刻まで75分未満なら提案しない(docs/01 §8)
	if (targetAt !== null && isTooLate(targetAt, now)) return "skipped";

	// 2. 既存の提案履歴(ペア単位・low < high に正規化)
	const [userLow, userHigh] =
		a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
	const [existing] = await db
		.select()
		.from(proposalHistory)
		.where(
			and(
				eq(proposalHistory.userLow, userLow),
				eq(proposalHistory.userHigh, userHigh),
			),
		);
	if (existing !== undefined) {
		// つながりIntentは既存行があれば一切再提案しない。機会もdeferred/expired以外は不可
		if (targetAt === null) return "skipped";
		if (existing.outcome !== "deferred" && existing.outcome !== "expired") {
			return "skipped";
		}
		const prev = await prevLatchOf(db, existing.latchId);
		if (prev !== null) {
			// 再提案判定用に前回LATCHのscoreを記録する(再提案でもスキップでも)
			await db
				.update(matchCandidates)
				.set({ prevLatchScore: prev.score })
				.where(eq(matchCandidates.id, rowId));
		}
		// 抑制: now >= updated_at + min(24時間, (対象時刻 - updated_at)/2)(docs/01 §8)
		const since = existing.updatedAt.getTime();
		const suppression = Math.min(
			LATCH.REPROPOSAL_SUPPRESSION_MAX_MS,
			(targetAt.getTime() - since) / 2,
		);
		if (now.getTime() < since + suppression) return "skipped";
		// 前回LATCHが無い場合は変化の有無を判定できないため再提案しない
		if (prev === null) return "skipped";
		const changed =
			prev.score !== score ||
			a.updatedAt.getTime() > prev.createdAt.getTime() ||
			b.updatedAt.getTime() > prev.createdAt.getTime();
		if (!changed) return "skipped";
	}

	// 3. 提示か保留か(F4a設計 §3.3)
	const present = await canPresent(db, [a.userId, b.userId], [a.id, b.id], now);

	const base = baseIntentOf(a, b);
	const regionName =
		base.geoCenterLat !== null &&
		base.geoCenterLng !== null &&
		base.geoRadiusM !== null
			? await lookupRegionName(db, {
					lat: base.geoCenterLat,
					lng: base.geoCenterLng,
				})
			: null;
	const proposal = buildProposal(a, b, regionName);
	const expiresAt = minExpiry(a, b);
	const status = present ? "proposed" : "candidate";
	// 保留中の回答期限は暫定でexpires_at(提示時に計算し直す・F4a設計 §3.5)
	const deadline = present
		? responseDeadline(form, now, targetAt, expiresAt)
		: expiresAt;
	const latchId = newUlid();
	const nowMs = now.getTime();
	const secured = sql`EXISTS (SELECT 1 FROM proposal_history WHERE latch_id = ${latchId})`;

	// 4. 1文目(外部キー検査の遅延指定を除く)=履歴の確保。新規はINSERT(UNIQUE衝突は何もしない)・再提案は読んだ値を条件とするUPDATE
	const claim =
		existing === undefined
			? db
					.insert(proposalHistory)
					.values({
						id: newUlid(),
						userLow,
						userHigh,
						latchId,
						outcome: "proposed",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing({
						target: [proposalHistory.userLow, proposalHistory.userHigh],
					})
			: db
					.update(proposalHistory)
					.set({ outcome: "proposed", latchId, updatedAt: now })
					.where(
						and(
							eq(proposalHistory.id, existing.id),
							inArray(proposalHistory.outcome, ["deferred", "expired"]),
							eq(proposalHistory.updatedAt, existing.updatedAt),
						),
					);

	// 2文目以降はすべて履歴確保の成功(latch_id=新idの行の存在)を条件とする。
	// INSERT … SELECT の列順は各テーブル定義の列順(drizzleのinsert().select())
	const insertLatch = db.insert(latches).select(
		sql`SELECT ${latchId}, ${form}, ${JSON.stringify([a.id, b.id])}, ${JSON.stringify(proposal)}, ${score}, ${status},
			${deadline.getTime()}, ${expiresAt.getTime()}, ${nowMs}, NULL, ${present ? nowMs : null}, ${nowMs}, ${nowMs}
			WHERE ${secured}`,
	);
	const insertMember = (userId: string) =>
		db
			.insert(latchMembers)
			.select(sql`SELECT ${latchId}, ${userId} WHERE ${secured}`);
	const insertEvent = db
		.insert(latchStatusEvents)
		.select(
			sql`SELECT ${newUlid()}, ${latchId}, NULL, ${status}, ${nowMs} WHERE ${secured}`,
		);
	const markCandidate = db
		.update(matchCandidates)
		.set({ status: "proposed", updatedAt: now })
		.where(and(eq(matchCandidates.id, rowId), secured));
	const insertNotification = (userId: string) =>
		db
			.insert(notifications)
			.select(
				sql`SELECT ${newUlid()}, ${userId}, 'proposal', ${latchId}, NULL, ${nowMs} WHERE ${secured}`,
			);

	const notifyStatements = present
		? [insertNotification(a.userId), insertNotification(b.userId)]
		: [];
	await db.batch([
		// proposal_history.latch_id → latches.id の外部キー検査をコミット時へ遅らせる
		// (履歴確保を1文目に置くため。D1のバッチは1トランザクションで、終了時に自動で戻る)
		db.run(sql`PRAGMA defer_foreign_keys = ON`),
		claim,
		insertLatch,
		insertMember(a.userId),
		insertMember(b.userId),
		insertEvent,
		markCandidate,
		...notifyStatements,
	]);

	// 5. 履歴を確保できなかった(並行した別の提案化が先に確保した等)ならLATCHは無い
	const created = await db
		.select({ id: latches.id })
		.from(latches)
		.where(eq(latches.id, latchId));
	if (created.length === 0) return "skipped";
	return present ? "proposed" : "held";
};
