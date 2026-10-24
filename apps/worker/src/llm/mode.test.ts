import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock/clock";
import { createLlm, resolveLlmMode } from "./mode";
import { JEV_AXES } from "./types";

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

describe("createLlm(07 §2: 3系統の束ね)", () => {
	it("mode=realでキーが揃えば例外なく関数を返す", () => {
		const llm = createLlm(
			{
				LATCH_LLM_MODE: "real",
				ANTHROPIC_API_KEY: "test-a",
				TYPESAFE_API_KEY: "test-t",
				DB: {},
			} as unknown as Env,
			fixed,
		);
		expect(typeof llm.parser).toBe("function");
		expect(typeof llm.jev.primary).toBe("function");
		expect(typeof llm.jev.fallback).toBe("function");
	});

	it("mode=realでキーが無ければ ENV_MISSING_LLM_KEY", () => {
		expect(() =>
			createLlm({ LATCH_LLM_MODE: "real" } as unknown as Env, fixed),
		).toThrow(/^ENV_MISSING_LLM_KEY/);
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

	it("llm.parserは構築時に注入したclockで解析し、成功を{ok:true}で返す", async () => {
		const llm = createLlm({ LATCH_LLM_MODE: "stub" } as unknown as Env, fixed);
		const outcome = await llm.parser("日曜17時にカレー会");
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.output.time?.start).toBe("2026-10-18T17:00:00+09:00");
		}
	});
});

describe("createLlm(07 §2: realのつなぎ方)", () => {
	const db = (env as unknown as { DB: D1Database }).DB;
	// 他の試験の行と混ざらない日付(JST)
	const clock = fixedClock(new Date("2031-05-01T00:00:00+09:00"));
	const countOf = async (key: string): Promise<number> =>
		(
			await db
				.prepare(
					"SELECT count FROM usage_counters WHERE scope='external_send' AND key=? AND period='2031-05-01'",
				)
				.bind(key)
				.first<{ count: number }>()
		)?.count ?? 0;

	const axes = Object.fromEntries(JEV_AXES.map((a) => [a, 0.5]));
	const anthropicResponse = (value: unknown) =>
		new Response(
			JSON.stringify({
				content: [{ type: "text", text: JSON.stringify(value) }],
				stop_reason: "end_turn",
			}),
			{ status: 200 },
		);

	it("parser→Anthropic(anthropic:parser)・jev.primary→TypeSafe(typesafe:jev)・jev.fallback→Anthropic(anthropic:jev)", async () => {
		const urls: string[] = [];
		const fetchFn = (async (url: unknown, init: RequestInit) => {
			urls.push(String(url));
			if (String(url).startsWith("https://api.typesafe.ai/")) {
				return new Response(
					JSON.stringify({
						model: "jev-1.14.0",
						answers: Object.fromEntries(
							JEV_AXES.map((a) => [a, { type: "noul", noul: 0.5 }]),
						),
					}),
					{ status: 200 },
				);
			}
			const body = JSON.parse(init.body as string) as { system: string };
			return body.system.includes("読み解く係")
				? anthropicResponse({
						form: "connection",
						topic: "ボードゲーム",
						category: null,
						time: null,
						participants: { min: 2, max: 2 },
						budget: null,
						alcohol_involved: false,
						warnings: [],
					})
				: anthropicResponse(axes);
		}) as unknown as typeof fetch;
		const llm = createLlm(
			{
				LATCH_LLM_MODE: "real",
				ANTHROPIC_API_KEY: "test-a",
				TYPESAFE_API_KEY: "test-t",
				DB: db,
			} as unknown as Env,
			clock,
			{ fetchFn },
		);
		const input = { normalizedA: "a", normalizedB: "b" };

		expect((await llm.parser("ボードゲーム")).ok).toBe(true);
		expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
		expect(await countOf("anthropic:parser")).toBe(1);

		expect((await llm.jev.primary(input)).ok).toBe(true);
		expect(urls[1]).toBe("https://api.typesafe.ai/v1/systemone");
		expect(await countOf("typesafe:jev")).toBe(1);

		expect((await llm.jev.fallback(input)).ok).toBe(true);
		expect(urls[2]).toBe("https://api.anthropic.com/v1/messages");
		expect(await countOf("anthropic:jev")).toBe(1);
		expect(urls).toHaveLength(3);
	});
});
