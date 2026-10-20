/**
 * Jev circuit breakerの統合試験(docs/06 §5)。KV(PIPELINE_KV)を使う。
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BREAKER_KEY,
	isBreakerOpen,
	recordJevOutcome,
} from "../src/jev/breaker";

const kv = env.PIPELINE_KV;
const T0 = new Date("2026-10-20T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const fail = async (n: number, now: Date) => {
	for (let i = 0; i < n; i++) await recordJevOutcome(kv, false, now);
};

describe("circuit breaker", () => {
	beforeEach(async () => {
		await kv.delete(BREAKER_KEY);
	});

	it("9連続失敗ではclosed・10回目でopen", async () => {
		await fail(9, T0);
		expect(await isBreakerOpen(kv, T0)).toBe(false);
		await fail(1, T0);
		expect(await isBreakerOpen(kv, T0)).toBe(true);
	});

	it("openから30分後にはclosedへ戻る", async () => {
		await fail(10, T0);
		expect(await isBreakerOpen(kv, at(30 * 60_000 - 1))).toBe(true);
		expect(await isBreakerOpen(kv, at(30 * 60_000))).toBe(false);
	});

	it("失敗5回→5分超経過→失敗5回では窓がリセットされclosed", async () => {
		await fail(5, T0);
		await fail(5, at(5 * 60_000 + 1));
		expect(await isBreakerOpen(kv, at(5 * 60_000 + 1))).toBe(false);
	});

	it("失敗9回→成功→失敗1回ではclosed", async () => {
		await fail(9, T0);
		await recordJevOutcome(kv, true, T0);
		await fail(1, T0);
		expect(await isBreakerOpen(kv, T0)).toBe(false);
	});
});
