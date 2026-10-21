/**
 * matchedのLATCHのcompleted判定(Cron (d)・docs/06 §2・F5設計 §2)。
 * - つながり: last_message_at(最終メッセージ。0件ならmatched時刻)から90日経過
 * - 機会: 対象時刻(proposal.time_window.start。グループは全員のstarts_atの最大値)から3時間経過
 * 1件ごとに状態の記録と状態の更新を1バッチで書き、どちらも「今もmatchedで境界を過ぎている」で
 * 条件付ける(並行したleave・F6のメッセージによるlast_message_atの更新と競合しても誤って閉じない)。
 * Intentの状態・proposal_historyは変えず、通知も作らない(つながりの静穏・docs/01 §8)
 */
import { LATCH, PIPELINE } from "@latch/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { latches, latchStatusEvents } from "../db/schema";
import { newUlid } from "../ids";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";

const logger = createLogger();

/** つながりの境界。last_message_atがこれ以下なら対象 */
export const connectionCompletionCutoff = (now: Date): Date =>
	new Date(now.getTime() - LATCH.CONNECTION_QUIET_MS);

/**
 * 機会の境界(ISO 8601・UTC)。time_window.startがこれ以下なら対象。
 * time_window.startもtoISOString()の表記のため、文字列の辞書順が時刻順と一致する
 */
export const occasionCompletionCutoffIso = (now: Date): string =>
	new Date(
		now.getTime() - LATCH.OCCASION_COMPLETE_AFTER_START_MS,
	).toISOString();

const timeWindowStart = sql`json_extract(${latches.proposal}, '$.time_window.start')`;

/** form別の境界条件(latches表の列で書く) */
const dueCondition = (now: Date) => {
	const connectionCutoffMs = connectionCompletionCutoff(now).getTime();
	const occasionCutoff = occasionCompletionCutoffIso(now);
	return sql`((${latches.form} = 'connection' AND ${latches.lastMessageAt} <= ${connectionCutoffMs})
		OR (${latches.form} = 'occasion' AND ${timeWindowStart} <= ${occasionCutoff}))`;
};

/** 1件を条件付きでcompletedにする。更新が効いたらtrue */
export const completeOne = async (
	db: DrizzleD1Database,
	latchId: string,
	now: Date,
): Promise<boolean> => {
	const nowMs = now.getTime();
	const due = dueCondition(now);
	// 状態の更新より先に matched→completed を記録する(respondYesと同じ順・同じ条件)
	const insertEvent = db.insert(latchStatusEvents).select(
		sql`SELECT ${newUlid()}, id, 'matched', 'completed', ${nowMs} FROM latches
			WHERE id = ${latchId} AND status = 'matched' AND ${due}`,
	);
	const update = db
		.update(latches)
		.set({ status: "completed", completedAt: now, updatedAt: now })
		.where(and(eq(latches.id, latchId), eq(latches.status, "matched"), due))
		.returning({ id: latches.id });
	const [, updated] = await db.batch([insertEvent, update]);
	return updated.length > 0;
};

/**
 * 期限を過ぎたmatchedのLATCHをcompletedにし、form別の件数を返す。照会はつながりを
 * last_message_atの古い順・機会を対象時刻の古い順に、合計CRON_BATCH_LIMIT(500)件まで。
 * 1件の失敗はログを出して続行する(docs/06 §2・F4aの方式)
 */
export const completeDueLatches = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<{ connection: number; occasion: number }> => {
	const limit = PIPELINE.CRON_BATCH_LIMIT;
	const connectionIds = await db
		.select({ id: latches.id })
		.from(latches)
		.where(
			and(
				eq(latches.status, "matched"),
				eq(latches.form, "connection"),
				lte(latches.lastMessageAt, connectionCompletionCutoff(now)),
			),
		)
		.orderBy(asc(latches.lastMessageAt))
		.limit(limit);
	const rest = limit - connectionIds.length;
	const occasionIds =
		rest > 0
			? await db
					.select({ id: latches.id })
					.from(latches)
					.where(
						and(
							eq(latches.status, "matched"),
							eq(latches.form, "occasion"),
							sql`${timeWindowStart} <= ${occasionCompletionCutoffIso(now)}`,
						),
					)
					.orderBy(asc(timeWindowStart))
					.limit(rest)
			: [];

	const result = { connection: 0, occasion: 0 };
	for (const [layer, rows] of [
		["connection", connectionIds],
		["occasion", occasionIds],
	] as const) {
		for (const { id } of rows) {
			try {
				if (await completeOne(db, id, now)) result[layer] += 1;
			} catch (error) {
				logger.warn("cron.item.failed", {
					latch_id: id,
					error_code: errorCodeOf(error),
				});
			}
		}
		if (result[layer] > 0) {
			logger.info("cron.completion.done", { layer, count: result[layer] });
		}
	}
	return result;
};
