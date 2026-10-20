/**
 * Jev実行器の統合試験(docs/06 §5〜§6・設計書 §2.3)。
 * 予算(D1)とbreaker(KV)は実物、Jev本体はfakeを注入する。
 */

import { env } from "cloudflare:test";
import { LATCH } from "@latch/shared";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock, jstDayKey } from "../src/clock/clock";
import { BREAKER_KEY, recordJevOutcome } from "../src/jev/breaker";
import { type JevTarget, runJev } from "../src/jev/runner";
import { JEV_TIMEOUT_MARKER, stubJev } from "../src/llm/stub/jev";
import type { JevAxes, JevFn } from "../src/llm/types";

const db = drizzle(env.DB);
const kv = env.PIPELINE_KV;
const NOW = new Date("2026-10-20T03:00:00Z");
const clock = fixedClock(NOW);
const origin = { intentId: "i-run", userId: "u-run" };

const targets = (n: number): JevTarget[] =>
	Array.from({ length: n }, (_, i) => ({
		key: `c${i}`,
		input: { normalizedA: `a${i}`, normalizedB: `b${i}` },
	}));

const run = (primary: JevFn, fallback: JevFn, ts: JevTarget[]) =>
	runJev({ jev: { primary, fallback }, db, kv, clock }, origin, ts);

const failWith =
	(kind: "timeout" | "invalid_output"): JevFn =>
	async () => ({ ok: false, kind });

/** axes.size + 保留の総和 = 対象数(1対象は1回だけ数える) */
const accounted = (r: Awaited<ReturnType<typeof run>>) =>
	r.axes.size + Object.values(r.held).reduce((a, b) => a + b, 0);

describe("runJev", () => {
	beforeEach(async () => {
		await env.DB.exec("DELETE FROM usage_counters");
		await kv.delete(BREAKER_KEY);
	});

	it("20件・全成功: 枠8で打ち切り、残り12件はcap", async () => {
		const r = await run(stubJev, stubJev, targets(20));
		expect(r.calls).toBe(LATCH.JEV_CALLS_PER_EVENT);
		expect(r.axes.size).toBe(8);
		expect(r.held.cap).toBe(12);
		expect(accounted(r)).toBe(20);
	});

	it("1件がtimeout: fallbackで救われ calls=4・axes=3", async () => {
		const ts = targets(3);
		ts[1].input.normalizedA = `${JEV_TIMEOUT_MARKER}x`;
		const primary: JevFn = stubJev;
		// fallbackはマーカーを無視して成功するfake
		const fallback: JevFn = async () => ({ ok: true, axes: {} as JevAxes });
		const r = await run(primary, fallback, ts);
		expect(r.calls).toBe(4);
		expect(r.axes.size).toBe(3);
		expect(accounted(r)).toBe(3);
	});

	it("primaryもfallbackもtimeout: calls=4・held.failed=2", async () => {
		const r = await run(failWith("timeout"), failWith("timeout"), targets(2));
		expect(r.calls).toBe(4);
		expect(r.held.failed).toBe(2);
		expect(r.axes.size).toBe(0);
	});

	it("invalid_outputはfallbackしない: held.failed=1・calls=1", async () => {
		const r = await run(failWith("invalid_output"), stubJev, targets(1));
		expect(r.calls).toBe(1);
		expect(r.held.failed).toBe(1);
	});

	it("fallback待ちが枠切れ: 8件全てtimeoutなら枠が尽きてcap", async () => {
		const r = await run(failWith("timeout"), stubJev, targets(8));
		expect(r.calls).toBe(8);
		expect(r.held.cap).toBe(8);
		expect(accounted(r)).toBe(8);
	});

	it("breakerが事前にopen: 呼ばずにheld.breaker=対象数", async () => {
		for (let i = 0; i < LATCH.BREAKER_FAILURES; i++) {
			await recordJevOutcome(kv, false, NOW);
		}
		const r = await run(stubJev, stubJev, targets(5));
		expect(r.calls).toBe(0);
		expect(r.held.breaker).toBe(5);
		expect(accounted(r)).toBe(5);
	});

	it("jev_intentの当日カウンタが40: 呼ばずにheld.budget=対象数", async () => {
		await env.DB.prepare(
			"INSERT INTO usage_counters (scope, key, period, count) VALUES ('jev_intent', ?, ?, 40)",
		)
			.bind(origin.intentId, jstDayKey(NOW))
			.run();
		const r = await run(stubJev, stubJev, targets(5));
		expect(r.calls).toBe(0);
		expect(r.held.budget).toBe(5);
		expect(accounted(r)).toBe(5);
	});

	it("予算が途中で尽きる: 予約できた分だけ呼び、残りはbudget", async () => {
		await env.DB.prepare(
			"INSERT INTO usage_counters (scope, key, period, count) VALUES ('jev_intent', ?, ?, 38)",
		)
			.bind(origin.intentId, jstDayKey(NOW))
			.run();
		const r = await run(stubJev, stubJev, targets(5));
		expect(r.calls).toBe(2);
		expect(r.axes.size).toBe(2);
		expect(r.held.budget).toBe(3);
		expect(accounted(r)).toBe(5);
	});

	it("8件の呼び出しは並列(全開始が最初の完了より前)", async () => {
		const log: string[] = [];
		const slow: JevFn = async (input) => {
			log.push(`start:${input.normalizedA}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
			log.push(`end:${input.normalizedA}`);
			return { ok: true, axes: {} as JevAxes };
		};
		await run(slow, slow, targets(8));
		expect(log.findIndex((l) => l.startsWith("end:"))).toBe(8);
	});
});
