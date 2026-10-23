import { describe, expect, it, vi } from "vitest";
import { JEV_AXES } from "../types";
import { anthropicJev } from "./jev-anthropic";

const input = { normalizedA: "A", normalizedB: "B" };
const axes = (over: Record<string, unknown> = {}) =>
	Object.fromEntries(JEV_AXES.map((a) => [a, over[a] ?? 0.4]));
const fetchReturning = (value: unknown) =>
	(async () =>
		new Response(
			JSON.stringify({
				content: [{ type: "text", text: JSON.stringify(value) }],
				stop_reason: "end_turn",
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;

describe("anthropicJev", () => {
	it("7軸のJSONはok", async () => {
		const r = await anthropicJev({
			apiKey: "k",
			fetchFn: fetchReturning(axes({ latent_yes: 0.8 })),
		})(input);
		expect(r).toEqual({ ok: true, axes: axes({ latent_yes: 0.8 }) });
	});

	it.each([
		[
			"欠け",
			(() => {
				const a = axes();
				delete a.social_fit;
				return a;
			})(),
		],
		["範囲外", axes({ social_fit: -0.1 })],
		["文字列", axes({ social_fit: "0.3" })],
	])("%sはinvalid_output", async (_n, v) => {
		expect(
			await anthropicJev({ apiKey: "k", fetchFn: fetchReturning(v) })(input),
		).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("6秒でtimeout", async () => {
		const fetchFn = ((_u: unknown, init: RequestInit) =>
			new Promise((_res, rej) => {
				init.signal?.addEventListener("abort", () =>
					rej(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		vi.useFakeTimers();
		const p = anthropicJev({ apiKey: "k", fetchFn })(input);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await p).toEqual({ ok: false, kind: "timeout" });
		vi.useRealTimers();
	});
});
