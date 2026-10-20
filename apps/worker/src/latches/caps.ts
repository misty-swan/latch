/**
 * 提示か保留かの上限判定(F4a設計 §3.3・docs/01 §10・docs/01 §8)。
 * 判定と書き込みは同一文ではないため、並行消費で上限を1件程度超え得る(設計 §3.3で許容)。
 */

import { LATCH, LIMITS } from "@latch/shared";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jstDayStart } from "../clock/clock";
import { latches, notifications } from "../db/schema";

/**
 * 次をすべて満たせば提示してよい:
 * - 各ユーザーの当日(JST)のtype=proposal通知が LIMITS.NOTIFICATIONS_PER_DAY 件未満
 * - 各Intentを含む進行中(proposed / partial_accept)のLATCHが LATCH.CONCURRENT_PER_INTENT 件未満
 *   (保留中のcandidateは数えない)
 */
export const canPresent = async (
	db: DrizzleD1Database,
	userIds: string[],
	intentIds: string[],
	now: Date,
): Promise<boolean> => {
	if (userIds.length > 0) {
		const perUser = await db
			.select({ userId: notifications.userId, n: count() })
			.from(notifications)
			.where(
				and(
					inArray(notifications.userId, userIds),
					eq(notifications.type, "proposal"),
					gte(notifications.createdAt, jstDayStart(now)),
				),
			)
			.groupBy(notifications.userId);
		if (perUser.some((r) => r.n >= LIMITS.NOTIFICATIONS_PER_DAY)) return false;
	}

	if (intentIds.length > 0) {
		// latches.intent_ids(JSON配列)は json_each で展開して照合する
		const perIntent = await db.all<{ intent_id: string; n: number }>(
			sql`SELECT j.value AS intent_id, COUNT(*) AS n
				FROM ${latches}, json_each(${latches.intentIds}) AS j
				WHERE ${latches.status} IN ('proposed', 'partial_accept')
					AND j.value IN (${sql.join(
						intentIds.map((id) => sql`${id}`),
						sql`, `,
					)})
				GROUP BY j.value`,
		);
		if (perIntent.some((r) => r.n >= LATCH.CONCURRENT_PER_INTENT)) {
			return false;
		}
	}
	return true;
};
