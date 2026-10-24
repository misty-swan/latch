/**
 * Jev予算の統合試験(docs/06 §6)。usage_countersのD1行で4カウンタの加算と判定を確認する。
 */

import { env } from "cloudflare:test";
import { LIMITS } from "@latch/shared";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { jstDayKey } from "../src/clock/clock";
import { usageCounters } from "../src/db/schema";
import { reserveJevCalls } from "../src/jev/budget";

const db = drizzle(env.DB);
const NOW = new Date("2026-10-20T03:00:00Z");

const origin = { intentId: "i1", userId: "u1" };
const day = jstDayKey(NOW);
const monthKey = (d: string) => d.slice(0, 7);

const seed = async (
	scope: (typeof usageCounters.$inferInsert)["scope"],
	key: string,
	period: string,
	count: number,
) => db.insert(usageCounters).values({ scope, key, period, count });

const counts = async () => {
	const rows = await db.select().from(usageCounters);
	return Object.fromEntries(rows.map((r) => [r.scope, r.count]));
};

describe("reserveJevCalls", () => {
	beforeEach(async () => {
		await env.DB.exec("DELETE FROM usage_counters");
	});

	it("余裕があればn件とも許し各カウンタが+n", async () => {
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({ allowed: 8 });
		expect(await counts()).toEqual({
			jev_intent: 8,
			jev_user: 8,
			jev_global_daily: 8,
			jev_global_monthly: 8,
		});
	});

	it("intentの残りが3なら3件許し、各カウンタは1件ずつの確保と同じ+4", async () => {
		await seed("jev_intent", "i1", day, LIMITS.JEV_PER_INTENT_PER_DAY - 3);
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({
			allowed: 3,
			exhausted: "jev_intent",
		});
		const c = await counts();
		expect(c.jev_intent).toBe(LIMITS.JEV_PER_INTENT_PER_DAY + 1);
		expect(c.jev_user).toBe(4);
		expect(c.jev_global_daily).toBe(4);
		expect(c.jev_global_monthly).toBe(4);
	});

	it("残り0なら0件で各カウンタ+1", async () => {
		await seed("jev_intent", "i1", day, LIMITS.JEV_PER_INTENT_PER_DAY);
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({
			allowed: 0,
			exhausted: "jev_intent",
		});
		const c = await counts();
		expect(c.jev_intent).toBe(LIMITS.JEV_PER_INTENT_PER_DAY + 1);
		expect(c.jev_user).toBe(1);
	});

	it("n=1で上限ちょうどまでは許し、超えると0件", async () => {
		await seed("jev_global_daily", "-", day, LIMITS.JEV_GLOBAL_DAILY - 1);
		expect(await reserveJevCalls(db, origin, NOW, 1)).toEqual({ allowed: 1 });
		expect(await reserveJevCalls(db, origin, NOW, 1)).toEqual({
			allowed: 0,
			exhausted: "jev_global_daily",
		});
	});

	it("最小のカウンタが勝ち、同数なら intent → user → global の順", async () => {
		await seed("jev_intent", "i1", day, LIMITS.JEV_PER_INTENT_PER_DAY - 2);
		await seed("jev_user", "u1", day, LIMITS.JEV_PER_USER_PER_DAY - 2);
		await seed("jev_global_daily", "-", day, LIMITS.JEV_GLOBAL_DAILY - 1);
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({
			allowed: 1,
			exhausted: "jev_global_daily",
		});
		await env.DB.exec("DELETE FROM usage_counters");
		await seed("jev_intent", "i1", day, LIMITS.JEV_PER_INTENT_PER_DAY - 2);
		await seed("jev_user", "u1", day, LIMITS.JEV_PER_USER_PER_DAY - 2);
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({
			allowed: 2,
			exhausted: "jev_intent",
		});
	});

	it("global_monthlyの残りで止まる", async () => {
		await seed(
			"jev_global_monthly",
			"-",
			monthKey(day),
			LIMITS.JEV_GLOBAL_MONTHLY - 5,
		);
		expect(await reserveJevCalls(db, origin, NOW, 8)).toEqual({
			allowed: 5,
			exhausted: "jev_global_monthly",
		});
	});

	it("JSTの日付が変わると再び許す", async () => {
		await seed("jev_intent", "i1", day, LIMITS.JEV_PER_INTENT_PER_DAY);
		const next = new Date(NOW.getTime() + 24 * 60 * 60_000);
		expect(await reserveJevCalls(db, origin, next, 2)).toEqual({ allowed: 2 });
	});
});
