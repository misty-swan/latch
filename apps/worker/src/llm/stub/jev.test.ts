import { describe, expect, it } from "vitest";
import { isFallbackEligible, JEV_AXES, type JevFailureKind } from "../types";
import { JEV_TIMEOUT_MARKER, stubJev } from "./jev";

const axesOf = (r: Awaited<ReturnType<typeof stubJev>>) => {
	if (!r.ok) {
		throw new Error("成功を期待");
	}
	return r.axes;
};

describe("stubJev(07 §2(b)・§5: 全7軸の固定値)", () => {
	it("JEV_AXESは7軸を定義する", () => {
		expect(JEV_AXES).toEqual([
			"would_a_accept_b",
			"would_b_accept_a",
			"purpose_fit",
			"mood_fit",
			"timing_fit",
			"social_fit",
			"latent_yes",
		]);
	});

	it("通常入力は全7軸0.9(閾値0.60を確実に超える)", async () => {
		const result = await stubJev({
			normalizedA: "週末にランチしたい",
			normalizedB: "ランチ仲間を募集",
		});
		expect(JEV_AXES).toHaveLength(7);
		for (const axis of JEV_AXES) {
			expect(axesOf(result)[axis]).toBe(0.9);
		}
	});

	it("normalizedAが__jev_low__で始まれば全軸0.3", async () => {
		const result = await stubJev({
			normalizedA: "__jev_low__ なんとか",
			normalizedB: "普通",
		});
		for (const axis of JEV_AXES) {
			expect(axesOf(result)[axis]).toBe(0.3);
		}
	});

	it("normalizedB側が__jev_low__で始まっても全軸0.3", async () => {
		const result = await stubJev({
			normalizedA: "普通",
			normalizedB: "__jev_low__ なんとか",
		});
		for (const axis of JEV_AXES) {
			expect(axesOf(result)[axis]).toBe(0.3);
		}
	});

	it("マーカーが途中にあるだけでは下げない(前置のみで判定)", async () => {
		const result = await stubJev({
			normalizedA: "普通の文章 __jev_low__ が途中",
			normalizedB: "普通",
		});
		for (const axis of JEV_AXES) {
			expect(axesOf(result)[axis]).toBe(0.9);
		}
	});

	it("normalizedAが__jev_timeout__で始まれば{ok:false, kind:timeout}", async () => {
		expect(
			await stubJev({
				normalizedA: `${JEV_TIMEOUT_MARKER} x`,
				normalizedB: "普通",
			}),
		).toEqual({ ok: false, kind: "timeout" });
	});

	it("normalizedB側でもtimeout・lowとの併存ではtimeout優先", async () => {
		expect(
			await stubJev({
				normalizedA: "__jev_low__ x",
				normalizedB: `${JEV_TIMEOUT_MARKER} x`,
			}),
		).toEqual({ ok: false, kind: "timeout" });
	});

	it("同一入力は同一出力", async () => {
		const input = { normalizedA: "a", normalizedB: "b" };
		expect(await stubJev(input)).toEqual(await stubJev(input));
	});
});

describe("isFallbackEligible(07 §5: 切替対象はtimeout/rate_limited/overloaded/unavailableのみ)", () => {
	const cases: [JevFailureKind, boolean][] = [
		["timeout", true],
		["rate_limited", true],
		["overloaded", true],
		["unavailable", true],
		["invalid_output", false],
		["other", false],
	];
	for (const [kind, expected] of cases) {
		it(`${kind}は${expected}`, () => {
			expect(isFallbackEligible(kind)).toBe(expected);
		});
	}
});
