import { describe, expect, it } from "vitest";
import { JEV_AXES } from "../types";
import { stubJev } from "./jev";

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

	it("通常入力は全7軸0.9(閾値0.60を確実に超える)", () => {
		const result = stubJev({
			normalizedA: "週末にランチしたい",
			normalizedB: "ランチ仲間を募集",
		});
		expect(JEV_AXES).toHaveLength(7);
		for (const axis of JEV_AXES) {
			expect(result[axis]).toBe(0.9);
		}
	});

	it("normalizedAが__jev_low__で始まれば全軸0.3", () => {
		const result = stubJev({
			normalizedA: "__jev_low__ なんとか",
			normalizedB: "普通",
		});
		for (const axis of JEV_AXES) {
			expect(result[axis]).toBe(0.3);
		}
	});

	it("normalizedB側が__jev_low__で始まっても全軸0.3", () => {
		const result = stubJev({
			normalizedA: "普通",
			normalizedB: "__jev_low__ なんとか",
		});
		for (const axis of JEV_AXES) {
			expect(result[axis]).toBe(0.3);
		}
	});

	it("マーカーが途中にあるだけでは下げない(前置のみで判定)", () => {
		const result = stubJev({
			normalizedA: "普通の文章 __jev_low__ が途中",
			normalizedB: "普通",
		});
		for (const axis of JEV_AXES) {
			expect(result[axis]).toBe(0.9);
		}
	});
});
