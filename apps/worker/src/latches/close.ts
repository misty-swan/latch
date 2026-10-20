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
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
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
 * クローズ時の履歴の記録規則(F4b設計 §3.2・オーナー裁定1・2)。
 * - release: 全ペアとも履歴を消費しない。未提示の保留・排他・Intent削除・条件変更といった
 *   システムの都合で閉じる場合に使う(オーナー裁定 2026-10-20・docs/01 §8)
 * - actor: 閉じた本人(defer/no)を含むペアだけを outcome で記録し、他のペアは release
 * - non_yes: 回答期限切れ。有効なyesを持たない参加者を含むペアだけを expired で記録し、
 *   yesどうしのペアは release
 * 1対1では唯一のペアが常に対象となるため、F4aの挙動と一致する
 */
export type HistoryRule =
	| { kind: "release" }
	| { kind: "actor"; userId: string; outcome: "deferred" | "rejected" }
	| { kind: "non_yes"; outcome: "expired" };

/**
 * 履歴の更新文(すべて closed 条件付き)。(1) 対象ペアのうち outcome='proposed' の行のUPDATE (2) outcome='proposed' のまま
 * 残った行のうちこのLATCHのために新規に確保した行(created_at が LATCH作成以降)を削除
 * (3) 残った outcome='proposed' の行(再提案で確保した既存行)を expired に戻す。release は(2)(3)のみ
 */
const historyStatementsOf = (
	db: DrizzleD1Database,
	latchId: string,
	history: HistoryRule,
	closed: SQL,
	now: Date,
) => {
	const ofLatch = eq(proposalHistory.latchId, latchId);
	const stillProposed = eq(proposalHistory.outcome, "proposed");
	const release = [
		db
			.delete(proposalHistory)
			.where(
				and(
					ofLatch,
					stillProposed,
					sql`${proposalHistory.createdAt} >= (SELECT created_at FROM latches WHERE id = ${latchId})`,
					closed,
				),
			),
		db
			.update(proposalHistory)
			.set({ outcome: "expired", updatedAt: now })
			.where(and(ofLatch, stillProposed, closed)),
	];
	if (history.kind === "release") return release;
	const target =
		history.kind === "actor"
			? or(
					eq(proposalHistory.userLow, history.userId),
					eq(proposalHistory.userHigh, history.userId),
				)
			: sql`(${proposalHistory.userLow} NOT IN (${activeYesUsers(latchId)}) OR ${proposalHistory.userHigh} NOT IN (${activeYesUsers(latchId)}))`;
	return [
		// outcome='proposed'の行だけを対象にする。同じミリ秒・同じtoの二重クローズでは後着側にも
		// closedが真に見えるため、先着側が書いた行を上書きしない(開いたLATCHの行は常にproposed)
		db
			.update(proposalHistory)
			.set({ outcome: history.outcome, updatedAt: now })
			.where(and(ofLatch, stillProposed, target, closed)),
		...release,
	];
};

/** このLATCHで有効なyes(取り消していない)を持つ user_id の副問い合わせ */
const activeYesUsers = (latchId: string): SQL =>
	sql`SELECT user_id FROM latch_responses WHERE latch_id = ${latchId} AND response = 'yes' AND retracted_at IS NULL`;

/**
 * LATCHを to へ閉じる。現在の状態が fromStatuses に無い・行が無い・並行更新に負けた場合はfalse。
 * - latch_status_events に(更新直前の状態 → to)を記録する
 * - history が非nullなら、このLATCHを指す proposal_history 行をペアごとの規則で更新する
 *   (同ペアの履歴が別のLATCHへ移っていれば触らない・HistoryRule参照)。nullなら履歴を変えない(leave)
 * - 提示済み(proposed_atあり)なら参加者全員へ type=closed の通知を作る(docs/05 §3.3)。
 *   options.notify=false なら作らない(成立後の離脱 leave。closedは不成立の総称・docs/05 §2.2)
 */
export const closeLatch = async (
	db: DrizzleD1Database,
	latchId: string,
	to: CloseTo,
	history: HistoryRule | null,
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
					// 離脱済みの参加者には通知しない(F4b設計 §3.4)
					.where(
						and(eq(latchMembers.latchId, latchId), isNull(latchMembers.leftAt)),
					)
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
		history === null
			? []
			: historyStatementsOf(db, latchId, history, closed, now);
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
