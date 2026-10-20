import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock/clock";
import { createLlm, resolveLlmMode } from "./mode";

const fixed = fixedClock(new Date("2026-10-17T00:00:00Z"));

describe("resolveLlmMode(07 §2: 既定stub・不正値もstub)", () => {
	it("未設定はstub", () => {
		expect(resolveLlmMode(undefined)).toBe("stub");
	});

	it("stubはstub", () => {
		expect(resolveLlmMode("stub")).toBe("stub");
	});

	it("realはreal", () => {
		expect(resolveLlmMode("real")).toBe("real");
	});

	it("不正値(前後空白付き)はstubに倒す", () => {
		expect(resolveLlmMode(" nonsense")).toBe("stub");
	});

	it("空文字はstub", () => {
		expect(resolveLlmMode("")).toBe("stub");
	});
});

describe("createLlm(07 §2: 3系統の束ね・realは未接続)", () => {
	it("mode=realは未実装として例外を投げる", () => {
		expect(() =>
			createLlm({ LATCH_LLM_MODE: "real" } as unknown as Env, fixed),
		).toThrow("LLM_REAL_NOT_IMPLEMENTED");
	});

	it("mode=stubはparser/embedding/jevの3コンポーネントを持つLlmを返す", () => {
		const llm = createLlm({ LATCH_LLM_MODE: "stub" } as unknown as Env, fixed);
		expect(Object.keys(llm).sort()).toEqual(["embedding", "jev", "parser"]);
	});

	it("llm.jevはprimaryとfallbackの関数を持つ", () => {
		const llm = createLlm({ LATCH_LLM_MODE: "stub" } as unknown as Env, fixed);
		expect(typeof llm.jev.primary).toBe("function");
		expect(typeof llm.jev.fallback).toBe("function");
	});

	it("llm.parserは構築時に注入したclockで解析する", () => {
		const llm = createLlm({ LATCH_LLM_MODE: "stub" } as unknown as Env, fixed);
		expect(llm.parser("日曜17時にカレー会").time?.start).toBe(
			"2026-10-18T17:00:00+09:00",
		);
	});
});
