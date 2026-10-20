/**
 * 提案クローズの共通処理(F4a設計 §4.2・docs/05 §3.3)。
 * 回答(defer/no)・回答期限切れ・排他・Intent削除・保留の期限切れが共有する。
 * 1文目で更新直前の状態を遷移元として記録し(INSERT … SELECT・status IN fromStatuses)、
 * 2文目で「status IN fromStatuses」を条件とする楽観的なUPDATEを行い、後続の書き込みを
 * すべて「そのLATCHが status=to かつ updated_at=now であること」で条件付けた1つのD1バッチ
 * (1トランザクション)で書く。読んだ後に並行したyesで proposed→partial_accept へ進んでも
 * fromStatusesに含まれれば閉じられる。並行した別のクローズに負けた側の後続は0行となる。
 */

import type { LatchStatus } from "@latch/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
	proposalHistory,
} from "../db/schema";
import { newUlid } from "../ids";

export type CloseTo = "rejected" | "expired" | "cancelled";

/**
 * LATCHを to へ閉じる。現在の状態が fromStatuses に無い・行が無い・並行更新に負けた場合はfalse。
 * - latch_status_events に(更新直前の状態 → to)を記録する
 * - historyOutcome が非nullなら、このLATCHを指す proposal_history 行の outcome を更新する
 *   (同ペアの履歴が別のLATCHへ移っていれば触らない)。"release" は履歴を消費しない閉じ方で、
 *   未提示の保留・排他・Intent削除・条件変更といったシステムの都合で閉じる場合に使う
 *   (オーナー裁定 2026-10-20・docs/01 §8): このLATCHのために新規に確保した行(created_at が
 *   LATCH作成以降)は削除し、再提案で確保した既存行は expired に戻す
 * - 提示済み(proposed_atあり)なら参加者全員へ type=closed の通知を作る(docs/05 §3.3)。
 *   options.notify=false なら作らない(成立後の離脱 leave。closedは不成立の総称・docs/05 §2.2)
 */
export const closeLatch = async (
	db: DrizzleD1Database,
	latchId: string,
	to: CloseTo,
	historyOutcome: "rejected" | "deferred" | "expired" | "release" | null,
	fromStatuses: LatchStatus[],
	now: Date,
	options: { notify?: boolean } = {},
): Promise<boolean> => {
	const notify = options.notify ?? true;
	const [row] = await db
		.select({ status: latches.status, proposedAt: latches.proposedAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	if (row === undefined || !fromStatuses.includes(row.status)) return false;

	const members =
		notify && row.proposedAt !== null
			? await db
					.select({ userId: latchMembers.userId })
					.from(latchMembers)
					.where(eq(latchMembers.latchId, latchId))
			: [];

	const nowMs = now.getTime();
	const closed = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status = ${to} AND updated_at = ${nowMs})`;

	// 遷移元は更新直前の現在値から書く(respondYesと同じ方式)。同じトランザクション内で
	// 直後のUPDATEと同じ条件を見るため、記録とUPDATEの成否は一致する
	const insertEvent = db.insert(latchStatusEvents).select(
		sql`SELECT ${newUlid()}, id, status, ${to}, ${nowMs} FROM latches
				WHERE id = ${latchId} AND status IN (${sql.join(
					fromStatuses.map((s) => sql`${s}`),
					sql`, `,
				)})`,
	);
	const update = db
		.update(latches)
		.set({ status: to, updatedAt: now })
		.where(and(eq(latches.id, latchId), inArray(latches.status, fromStatuses)));
	const historyStatements =
		historyOutcome === null
			? []
			: historyOutcome === "release"
				? [
						// 新規確保の行は削除(ペアは未提案に戻る)。残った行=再提案で確保した既存行
						db
							.delete(proposalHistory)
							.where(
								and(
									eq(proposalHistory.latchId, latchId),
									sql`${proposalHistory.createdAt} >= (SELECT created_at FROM latches WHERE id = ${latchId})`,
									closed,
								),
							),
						db
							.update(proposalHistory)
							.set({ outcome: "expired", updatedAt: now })
							.where(and(eq(proposalHistory.latchId, latchId), closed)),
					]
				: [
						db
							.update(proposalHistory)
							.set({ outcome: historyOutcome, updatedAt: now })
							.where(and(eq(proposalHistory.latchId, latchId), closed)),
					];
	// UNIQUE(latch_id,user_id,type)の重複は何もしない。INSERT … SELECT のupsertはWHEREが必要(SQLiteの構文)
	const notifyStatements = members.map((m) =>
		db
			.insert(notifications)
			.select(
				sql`SELECT ${newUlid()}, ${m.userId}, 'closed', ${latchId}, NULL, ${nowMs} WHERE ${closed}`,
			)
			.onConflictDoNothing(),
	);

	await db.batch([
		insertEvent,
		update,
		...historyStatements,
		...notifyStatements,
	]);

	const [after] = await db
		.select({ status: latches.status, updatedAt: latches.updatedAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	return after?.status === to && after.updatedAt.getTime() === nowMs;
};
