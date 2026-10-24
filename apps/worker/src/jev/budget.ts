/**
 * Jev予算(usage_counters・docs/06 §6)。
 * 4つのカウンタ(1Intent/日・1ユーザー/日・全体1日・全体1か月)を呼び出し前に加算し、
 * 加算後の値が上限を超えたら呼び出しを許さない。
 */

import { LIMITS } from "@latch/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jstDayKey, jstMonthKey } from "../clock/clock";
import { usageCounters } from "../db/schema";

export type JevBudgetScope =
	| "jev_intent"
	| "jev_user"
	| "jev_global_daily"
	| "jev_global_monthly";

const GLOBAL_KEY = "-";

/**
 * Jev呼び出しn回分の予算を確保する(設計 §3.7の3)。4行へ+nを1回のdb.batchで加え、
 * 各カウンタの加算前の値(加算後 − n)から許せる件数を全カウンタの最小で決める。
 * 許せない件があれば、1件ずつ確保した場合と同じ最終値(尽きた1件は試行として数える)になるよう
 * n − allowed − 1 を同じ4行から1回のdb.batchで引く。
 * 尽きたカウンタが複数あれば intent → user → global_daily → global_monthly の順で最初の1つを返す。
 */
export const reserveJevCalls = async (
	db: DrizzleD1Database,
	origin: { intentId: string; userId: string },
	now: Date,
	n: number,
): Promise<{ allowed: number; exhausted?: JevBudgetScope }> => {
	if (n <= 0) return { allowed: 0 };
	const day = jstDayKey(now);
	const month = jstMonthKey(now);
	const targets: {
		scope: JevBudgetScope;
		key: string;
		period: string;
		limit: number;
	}[] = [
		{
			scope: "jev_intent",
			key: origin.intentId,
			period: day,
			limit: LIMITS.JEV_PER_INTENT_PER_DAY,
		},
		{
			scope: "jev_user",
			key: origin.userId,
			period: day,
			limit: LIMITS.JEV_PER_USER_PER_DAY,
		},
		{
			scope: "jev_global_daily",
			key: GLOBAL_KEY,
			period: day,
			limit: LIMITS.JEV_GLOBAL_DAILY,
		},
		{
			scope: "jev_global_monthly",
			key: GLOBAL_KEY,
			period: month,
			limit: LIMITS.JEV_GLOBAL_MONTHLY,
		},
	];
	const [s0, s1, s2, s3] = targets.map((t) =>
		db
			.insert(usageCounters)
			.values({ scope: t.scope, key: t.key, period: t.period, count: n })
			.onConflictDoUpdate({
				target: [usageCounters.scope, usageCounters.key, usageCounters.period],
				set: { count: sql`${usageCounters.count} + ${n}` },
			})
			.returning({ count: usageCounters.count }),
	);
	const results = await db.batch([s0, s1, s2, s3]);
	let allowed = n;
	let exhausted: JevBudgetScope | undefined;
	for (let i = 0; i < targets.length; i++) {
		const after = results[i][0]?.count ?? n;
		const before = after - n;
		const room = Math.min(n, Math.max(0, targets[i].limit - before));
		if (room < allowed) {
			allowed = room;
			exhausted = targets[i].scope;
		}
	}
	if (allowed < n) {
		const back = n - allowed - 1;
		if (back > 0) {
			const [u0, u1, u2, u3] = targets.map((t) =>
				db
					.update(usageCounters)
					.set({ count: sql`${usageCounters.count} - ${back}` })
					.where(
						and(
							eq(usageCounters.scope, t.scope),
							eq(usageCounters.key, t.key),
							eq(usageCounters.period, t.period),
						),
					),
			);
			await db.batch([u0, u1, u2, u3]);
		}
		return { allowed, exhausted };
	}
	return { allowed };
};
