import { describe, expect, it } from "vitest";
import { JEV_AXES } from "../types";
import { typesafeJev } from "./jev-typesafe";
import { JEV_QUESTIONS, TYPESAFE_MODEL } from "./prompts";

const FAKE_KEY = "test-typesafe-key";
const input = {
	normalizedA: "ボードゲームがしたい",
	normalizedB: "ボドゲ仲間",
};

const answers = (over: Record<string, unknown> = {}) =>
	Object.fromEntries(
		JEV_AXES.map((a) => [a, { type: "noul", noul: over[a] ?? 0.5 }]),
	);

const fetchJson = (status: number, body: unknown, calls: unknown[] = []) =>
	(async (url: unknown, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;

describe("typesafeJev", () => {
	it("要求の形と7軸の返りを写す", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const seen: string[] = [];
		const r = await typesafeJev({
			apiKey: FAKE_KEY,
			fetchFn: fetchJson(
				200,
				{ model: "jev-1.13.0", answers: answers({ purpose_fit: 0.9 }) },
				calls,
			),
			onModel: (m) => seen.push(m),
		})(input);
		expect(r).toEqual({
			ok: true,
			axes: expect.objectContaining({ purpose_fit: 0.9, latent_yes: 0.5 }),
		});
		expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
		const h = calls[0].init.headers as Record<string, string>;
		expect(h.Authorization ?? h.authorization).toBe(`Bearer ${FAKE_KEY}`);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.state).toEqual({
			intent_a: input.normalizedA,
			intent_b: input.normalizedB,
		});
		expect(body.model).toBe(TYPESAFE_MODEL);
		expect(Object.keys(body.questions)).toEqual([...JEV_AXES]);
		expect(body.questions.purpose_fit).toEqual({
			type: "noul",
			...JEV_QUESTIONS.purpose_fit,
		});
		expect(seen).toEqual(["jev-1.13.0"]);
	});

	it.each([
		[
			"軸の欠け",
			(() => {
				const a = answers() as Record<string, unknown>;
				delete a.mood_fit;
				return a;
			})(),
		],
		["範囲外", answers({ mood_fit: 1.2 })],
		["文字列", answers({ mood_fit: "0.5" })],
	])("%sはinvalid_output", async (_n, a) => {
		const r = await typesafeJev({
			apiKey: FAKE_KEY,
			fetchFn: fetchJson(200, { model: "m", answers: a }),
		})(input);
		expect(r).toEqual({ ok: false, kind: "invalid_output" });
	});

	it.each([
		[429, "rate_limited"],
		[503, "overloaded"],
		[529, "overloaded"],
		[500, "unavailable"],
		[502, "unavailable"],
		[400, "other"],
		[401, "other"],
	])("HTTP %i は %s", async (status, kind) => {
		const r = await typesafeJev({
			apiKey: FAKE_KEY,
			fetchFn: fetchJson(status, {}),
		})(input);
		expect(r).toEqual({ ok: false, kind });
	});

	it("通信の失敗はunavailable", async () => {
		const r = await typesafeJev({
			apiKey: FAKE_KEY,
			fetchFn: (async () => {
				throw new TypeError("net");
			}) as unknown as typeof fetch,
		})(input);
		expect(r).toEqual({ ok: false, kind: "unavailable" });
	});

	it("6秒で打ち切ってtimeout", async () => {
		const fetchFn = ((_u: unknown, init: RequestInit) =>
			new Promise((_res, rej) => {
				init.signal?.addEventListener("abort", () =>
					rej(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		const { vi } = await import("vitest");
		vi.useFakeTimers();
		const p = typesafeJev({ apiKey: FAKE_KEY, fetchFn })(input);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await p).toEqual({ ok: false, kind: "timeout" });
		vi.useRealTimers();
	});
});
