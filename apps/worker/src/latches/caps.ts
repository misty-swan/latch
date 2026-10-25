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
	const blockers = await presentBlockers(db, userIds, intentIds, now);
	return blockers.userIds.length === 0 && blockers.intentIds.length === 0;
};

/**
 * canPresent の判定の内訳: 上限に届いている利用者と意思を返す(どちらも空なら提示してよい)。
 * 保留の解放(release.ts)は、上限に届いた利用者・意思を覚えて後続の保留の照会を省く(#45)。
 * どちらの数も同じ走査の中の昇格では増える一方のため、重なる別の要求が無い限り、覚えた結果は
 * 走査の終わりまで変わらない。別の要求(回答・取り消し・日付の変わり目)が走査中に枠を空けても、
 * その走査では保留のまま残り、次の毎分Cronの解放が拾う
 */
export const presentBlockers = async (
	db: DrizzleD1Database,
	userIds: string[],
	intentIds: string[],
	now: Date,
): Promise<{ userIds: string[]; intentIds: string[] }> => {
	// 2つの照会は互いに依存しないため同時に投げる(D1の直列の待ちを1段にする・#36)。
	// 判定は従来どおり、どちらかが上限に達していれば保留
	const [perUser, perIntent] = await Promise.all([
		userIds.length > 0
			? db
					.select({ userId: notifications.userId, n: count() })
					.from(notifications)
					.where(
						and(
							inArray(notifications.userId, userIds),
							eq(notifications.type, "proposal"),
							gte(notifications.createdAt, jstDayStart(now)),
						),
					)
					.groupBy(notifications.userId)
			: Promise.resolve([]),
		intentIds.length > 0
			? // latches.intent_ids(JSON配列)は json_each で展開して照合する
				db.all<{ intent_id: string; n: number }>(
					sql`SELECT j.value AS intent_id, COUNT(*) AS n
					FROM ${latches}, json_each(${latches.intentIds}) AS j
					WHERE ${latches.status} IN ('proposed', 'partial_accept')
						AND j.value IN (${sql.join(
							intentIds.map((id) => sql`${id}`),
							sql`, `,
						)})
					GROUP BY j.value`,
				)
			: Promise.resolve([]),
	]);
	return {
		userIds: perUser
			.filter((r) => r.n >= LIMITS.NOTIFICATIONS_PER_DAY)
			.map((r) => r.userId),
		intentIds: perIntent
			.filter((r) => r.n >= LATCH.CONCURRENT_PER_INTENT)
			.map((r) => r.intent_id),
	};
};
