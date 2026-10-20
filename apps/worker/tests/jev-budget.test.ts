/**
 * Jev予算の統合試験(docs/06 §6)。usage_countersのD1行で4カウンタの加算と判定を確認する。
 */

import { env } from "cloudflare:test";
import { LIMITS } from "@latch/shared";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { jstDayKey } from "../src/clock/clock";
import { usageCounters } from "../src/db/schema";
import { reserveJevCall } from "../src/jev/budget";

const db = drizzle(env.DB);
const NOW = new Date("2026-10-20T03:00:00Z");

describe("reserveJevCall", () => {
	beforeEach(async () => {
		await env.DB.exec("DELETE FROM usage_counters");
	});

	it("1Intentは40回目までok・41回目にjev_intent", async () => {
		const origin = { intentId: "i1", userId: "u1" };
		for (let i = 0; i < LIMITS.JEV_PER_INTENT_PER_DAY; i++) {
			expect(await reserveJevCall(db, origin, NOW)).toEqual({ ok: true });
		}
		expect(await reserveJevCall(db, origin, NOW)).toEqual({
			ok: false,
			exhausted: "jev_intent",
		});
	});

	it("同一ユーザーの別Intent3つで計121回目にjev_user", async () => {
		const intents = ["a", "b", "c"];
		for (let i = 0; i < LIMITS.JEV_PER_USER_PER_DAY; i++) {
			const r = await reserveJevCall(
				db,
				{ intentId: intents[i % 3], userId: "u2" },
				NOW,
			);
			expect(r).toEqual({ ok: true });
		}
		expect(
			await reserveJevCall(db, { intentId: "d", userId: "u2" }, NOW),
		).toEqual({ ok: false, exhausted: "jev_user" });
	});

	it("JSTの日付が変わると再びok", async () => {
		const origin = { intentId: "i3", userId: "u3" };
		for (let i = 0; i <= LIMITS.JEV_PER_INTENT_PER_DAY; i++) {
			await reserveJevCall(db, origin, NOW);
		}
		const next = new Date(NOW.getTime() + 24 * 60 * 60_000);
		expect(await reserveJevCall(db, origin, next)).toEqual({ ok: true });
	});

	it("global_dailyが29,999なら2回目にjev_global_daily", async () => {
		await db.insert(usageCounters).values({
			scope: "jev_global_daily",
			key: "-",
			period: jstDayKey(NOW),
			count: LIMITS.JEV_GLOBAL_DAILY - 1,
		});
		const origin = { intentId: "i4", userId: "u4" };
		expect(await reserveJevCall(db, origin, NOW)).toEqual({ ok: true });
		expect(await reserveJevCall(db, origin, NOW)).toEqual({
			ok: false,
			exhausted: "jev_global_daily",
		});
	});
});
