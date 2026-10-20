/**
 * 提案クローズの共通処理(F4a設計 §4.2・docs/05 §3.3)。
 * 回答(defer/no)・回答期限切れ・排他・Intent削除・保留の期限切れが共有する。
 * LATCH行を読んだ状態を条件とする楽観的なUPDATEを1文目とし、後続の書き込みをすべて
 * 「そのLATCHが status=to かつ updated_at=now であること」で条件付けた1つのD1バッチ
 * (1トランザクション)で書く。並行した別のクローズ・回答に負けた側の後続は0行となる。
 */

import type { LatchStatus } from "@latch/shared";
import { and, eq, sql } from "drizzle-orm";
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
 * - latch_status_events に(読んだ状態 → to)を記録する
 * - historyOutcome が非nullなら、このLATCHを指す proposal_history 行の outcome を更新する
 *   (同ペアの履歴が別のLATCHへ移っていれば触らない)
 * - 提示済み(proposed_atあり)なら参加者全員へ type=closed の通知を作る(docs/05 §3.3)
 */
export const closeLatch = async (
	db: DrizzleD1Database,
	latchId: string,
	to: CloseTo,
	historyOutcome: "rejected" | "deferred" | "expired" | null,
	fromStatuses: LatchStatus[],
	now: Date,
): Promise<boolean> => {
	const [row] = await db
		.select({ status: latches.status, proposedAt: latches.proposedAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	if (row === undefined || !fromStatuses.includes(row.status)) return false;

	const members =
		row.proposedAt !== null
			? await db
					.select({ userId: latchMembers.userId })
					.from(latchMembers)
					.where(eq(latchMembers.latchId, latchId))
			: [];

	const nowMs = now.getTime();
	const closed = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status = ${to} AND updated_at = ${nowMs})`;

	const update = db
		.update(latches)
		.set({ status: to, updatedAt: now })
		.where(and(eq(latches.id, latchId), eq(latches.status, row.status)));
	const insertEvent = db
		.insert(latchStatusEvents)
		.select(
			sql`SELECT ${newUlid()}, ${latchId}, ${row.status}, ${to}, ${nowMs} WHERE ${closed}`,
		);
	const historyStatements =
		historyOutcome !== null
			? [
					db
						.update(proposalHistory)
						.set({ outcome: historyOutcome, updatedAt: now })
						.where(and(eq(proposalHistory.latchId, latchId), closed)),
				]
			: [];
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
		update,
		insertEvent,
		...historyStatements,
		...notifyStatements,
	]);

	const [after] = await db
		.select({ status: latches.status, updatedAt: latches.updatedAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	return after?.status === to && after.updatedAt.getTime() === nowMs;
};
