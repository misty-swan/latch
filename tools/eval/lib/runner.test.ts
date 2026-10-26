/**
 * 採点の実行(runGate)の試験。本物のAIは呼ばず、fetchを差し替えてreal実装を通す。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	JEV_ANTHROPIC_SYSTEM_PROMPT,
	TYPESAFE_MODEL,
} from "../../../apps/worker/src/llm/real/prompts";
import { JEV_AXES } from "../../../apps/worker/src/llm/types";
import { artifactsFingerprint, fingerprint } from "./fingerprint";
import { formatSummary, parseRetryAfter, runGate } from "./runner";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const keys = {
	anthropic: "sk-test-anthropic-xyz",
	typesafe: "ts-test-key-xyz",
};

const anthropicText = (value: unknown, usage = { input_tokens: 100 }) =>
	new Response(
		JSON.stringify({
			content: [{ type: "text", text: JSON.stringify(value) }],
			stop_reason: "end_turn",
			usage,
		}),
		{ status: 200 },
	);

const parserValue = {
	form: "connection",
	topic: "ボードゲーム",
	category: null,
	time: null,
	participants: { min: 2, max: 2 },
	budget: null,
	alcohol_involved: false,
	warnings: [],
};
const flatAxes = Object.fromEntries(JEV_AXES.map((a) => [a, 0.5]));

type Handler = (url: string, body: Record<string, unknown>) => Response;

const fakeFetch = (override?: Handler) => {
	const calls = { anthropic: 0, typesafe: 0 };
	let inFlight = 0;
	let maxInFlight = 0;
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 1));
		inFlight--;
		const custom = override?.(url, body);
		if (custom) return custom;
		if (url.includes("typesafe")) {
			calls.typesafe++;
			return new Response(
				JSON.stringify({
					model: "jev-1.13.0",
					answers: Object.fromEntries(JEV_AXES.map((a) => [a, { noul: 0.5 }])),
				}),
				{ status: 200 },
			);
		}
		calls.anthropic++;
		return anthropicText(
			body.system === JEV_ANTHROPIC_SYSTEM_PROMPT ? flatAxes : parserValue,
		);
	}) as typeof fetch;
	return { fn, calls, maxInFlight: () => maxInFlight };
};

describe("runGate", () => {
	it("ゴールドセット全件を流し、キー・URL・応答の本文を含まない記録を返す", async () => {
		const f = fakeFetch();
		const record = await runGate({
			repoRoot,
			keys,
			fetchFn: f.fn,
			sleep: async () => {},
			now: () => new Date("2026-10-24T00:00:00Z"),
		});
		// Parser 117件・Jevは採点する57組(59組からjev_scored: falseの2組を除く)×2順×(第一候補+予備)
		expect(f.calls.typesafe).toBe(114);
		expect(f.calls.anthropic).toBe(117 + 114);
		expect(f.maxInFlight()).toBeLessThanOrEqual(4);

		expect(record.ranAt).toBe("2026-10-24T00:00:00.000Z");
		expect(record.models).toEqual({
			anthropic: "claude-haiku-5-5",
			typesafe_requested: TYPESAFE_MODEL,
			typesafe_answered: ["jev-1.13.0"],
		});
		expect(record.goldset).toEqual({
			parserVersion: 2,
			jevVersion: 2,
			approvedByOwner: "2026-10-26",
		});
		expect(record.fingerprint).toEqual(fingerprint(repoRoot));
		expect(record.fingerprintArtifacts).toBe(artifactsFingerprint());
		// 全軸0.5なので順序整合は中央値0で合格・Parserは固定の出力なので不合格
		expect(record.scores.jev.primary.median).toBe(0);
		expect(record.scores.jev.fallback.median).toBe(0);
		expect(record.passed).toBe(false);
		expect(record.failures.length).toBeGreaterThan(0);
		expect(record.scores.parser.failures.length).toBeGreaterThan(0);
		expect(record.scores.jevAt060.primary.n).toBe(57);
		expect(record.scores.jevAt060.primary.actualPositive).toBe(30);
		// 全軸0.5のLATCH Scoreは0.60を超えないため、Recall@0.60の基準でも不合格になる
		expect(record.scores.jevAt060.primary.recall).toBe(0);
		expect(record.failures.join("\n")).toMatch(/Recall@0\.60\(第一候補/);
		expect(record.failures.join("\n")).toMatch(/Recall@0\.60\(予備/);
		expect(record.reference.inputTokensMean.parser).toBe(100);

		const text = JSON.stringify(record) + formatSummary(record);
		expect(text).not.toContain(keys.anthropic);
		expect(text).not.toContain(keys.typesafe);
		expect(text).not.toMatch(/https?:\/\//);
	});

	it("429はRetry-Afterだけ待ってから呼び直す", async () => {
		let first = true;
		const f = fakeFetch((url) => {
			if (url.includes("typesafe") && first) {
				first = false;
				return new Response("{}", {
					status: 429,
					headers: { "retry-after": "3" },
				});
			}
			return undefined as unknown as Response;
		});
		const sleep = vi.fn(async () => {});
		const record = await runGate({ repoRoot, keys, fetchFn: f.fn, sleep });
		expect(sleep).toHaveBeenCalledWith(3000);
		expect(record.scores.jev.primary.failedCalls).toBe(0);
	});

	it("429が続けば上限で打ち切り、失敗として数える", async () => {
		const f = fakeFetch((url) =>
			url.includes("typesafe")
				? new Response("{}", { status: 429 })
				: (undefined as unknown as Response),
		);
		const sleep = vi.fn(async () => {});
		const record = await runGate({ repoRoot, keys, fetchFn: f.fn, sleep });
		expect(record.scores.jev.primary.failedCalls).toBe(114);
		expect(record.scores.jev.primary.median).toBeNull();
		expect(record.passed).toBe(false);
		expect(record.failures.join("\n")).toMatch(/第一候補/);
	});
});

describe("parseRetryAfter", () => {
	it("秒数・日時・無しを待ち時間(ミリ秒)へ。上限60秒", () => {
		const now = new Date("2026-10-24T00:00:00Z");
		expect(parseRetryAfter("3", now)).toBe(3000);
		expect(parseRetryAfter("Sat, 24 Oct 2026 00:00:10 GMT", now)).toBe(10_000);
		expect(parseRetryAfter(null, now)).toBe(5000);
		expect(parseRetryAfter("600", now)).toBe(60_000);
		expect(parseRetryAfter("abc", now)).toBe(5000);
	});
});
