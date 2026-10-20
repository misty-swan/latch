/**
 * Jev予算(usage_counters・docs/06 §6)。
 * 4つのカウンタ(1Intent/日・1ユーザー/日・全体1日・全体1か月)を呼び出し前に加算し、
 * 加算後の値が上限を超えたら呼び出しを許さない。
 */

import { LIMITS } from "@latch/shared";
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jstDayKey, jstMonthKey } from "../clock/clock";
import { usageCounters } from "../db/schema";

export type JevBudgetScope =
	| "jev_intent"
	| "jev_user"
	| "jev_global_daily"
	| "jev_global_monthly";

export type BudgetResult =
	| { ok: true }
	| { ok: false; exhausted: JevBudgetScope };

const GLOBAL_KEY = "-";

/**
 * Jev呼び出し1回分の予算を確保する。4行をdb.batchで1往復で加算する。
 * 超過時も加算は取り消さない(試行自体を数える・設計書 §2.4)。
 * 超過が複数あれば intent → user → global_daily → global_monthly の順で最初の1つを返す。
 */
export const reserveJevCall = async (
	db: DrizzleD1Database,
	origin: { intentId: string; userId: string },
	now: Date,
): Promise<BudgetResult> => {
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
			.values({ scope: t.scope, key: t.key, period: t.period, count: 1 })
			.onConflictDoUpdate({
				target: [usageCounters.scope, usageCounters.key, usageCounters.period],
				set: { count: sql`${usageCounters.count} + 1` },
			})
			.returning({ count: usageCounters.count }),
	);
	const results = await db.batch([s0, s1, s2, s3]);
	for (let i = 0; i < targets.length; i++) {
		const count = results[i][0]?.count ?? 0;
		if (count > targets[i].limit) {
			return { ok: false, exhausted: targets[i].scope };
		}
	}
	return { ok: true };
};
