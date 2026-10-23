import { CATEGORIES } from "@latch/shared";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../clock/clock";
import { realParser } from "./parser";

const FAKE_KEY = "test-anthropic-key";
// 2026-10-24 09:00 JST
const clock = fixedClock(new Date("2026-10-24T00:00:00Z"));

const valid = {
	form: "occasion",
	topic: "ボードゲーム",
	category: CATEGORIES[0],
	time: { start: "2026-10-25T19:00:00+09:00", end: null },
	participants: { min: 2, max: 4 },
	budget: { min: 3000, max: 5000 },
	alcohol_involved: false,
	expires_at_options: ["1999-01-01T00:00:00+09:00"],
	warnings: [{ field: "geo", note: "場所は地図で設定してください" }],
};

const fetchReturning = (value: unknown, calls: RequestInit[] = []) =>
	(async (_url: unknown, init: RequestInit) => {
		calls.push(init);
		return new Response(
			JSON.stringify({
				content: [{ type: "text", text: JSON.stringify(value) }],
				stop_reason: "end_turn",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;

const run = (value: unknown, calls: RequestInit[] = []) =>
	realParser({
		apiKey: FAKE_KEY,
		clock,
		fetchFn: fetchReturning(value, calls),
	})("明日19時にボードゲーム");

describe("realParser", () => {
	it("正しい出力はParserOutputになり、期限の選択肢はコードで求める", async () => {
		const r = await run(valid);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.output.topic).toBe("ボードゲーム");
		expect(r.output.expires_at_options).toEqual(["2026-10-25T22:00:00+09:00"]);
		expect(r.output.warnings).toHaveLength(1);
	});

	it("つながりの期限の選択肢は現在時刻から7/30/90日", async () => {
		const r = await run({ ...valid, form: "connection", time: null });
		expect(r.ok && r.output.expires_at_options).toEqual([
			"2026-10-31T09:00:00+09:00",
			"2026-11-23T09:00:00+09:00",
			"2027-01-22T09:00:00+09:00",
		]);
	});

	it("categoryがnullなら通す", async () => {
		expect((await run({ ...valid, category: null })).ok).toBe(true);
	});

	it.each([
		["カテゴリが一覧の外", { ...valid, category: "存在しない" }],
		[
			"time.startが不正なISO",
			{ ...valid, time: { start: "あした", end: null } },
		],
		[
			"time.startにオフセットが無い",
			{ ...valid, time: { start: "2026-10-25T19:00:00", end: null } },
		],
		["participants.maxが5", { ...valid, participants: { min: 2, max: 5 } }],
		[
			"participants.minがmaxより大きい",
			{ ...valid, participants: { min: 4, max: 3 } },
		],
		["予算が負", { ...valid, budget: { min: -1, max: 5 } }],
		["予算のminがmaxより大きい", { ...valid, budget: { min: 9, max: 5 } }],
		["topicが空", { ...valid, topic: "" }],
		["formが不正", { ...valid, form: "x" }],
	])("%sはinvalid_output", async (_n, value) => {
		expect(await run(value)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("要求の本文にraw_textと現在時刻(JST)以外の利用者情報を含めず、timeoutは10000ms", async () => {
		const calls: RequestInit[] = [];
		await run(valid, calls);
		const body = JSON.parse(calls[0]?.body as string);
		expect(body.messages).toEqual([
			{ role: "user", content: "明日19時にボードゲーム" },
		]);
		expect(body.system).toContain("2026-10-24T09:00:00+09:00");
		expect(Object.keys(body).sort()).toEqual(
			[
				"max_tokens",
				"messages",
				"model",
				"output_config",
				"system",
				"thinking",
			].sort(),
		);
	});

	it("timeoutMsは10000", async () => {
		const spy: number[] = [];
		const orig = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			if (ms !== undefined) spy.push(ms);
			return orig(fn, ms);
		}) as typeof setTimeout;
		try {
			await run(valid);
		} finally {
			globalThis.setTimeout = orig;
		}
		expect(spy).toContain(10000);
	});

	it("通信の失敗は種別つきで返す", async () => {
		const p = realParser({
			apiKey: FAKE_KEY,
			clock,
			fetchFn: (async () =>
				new Response("{}", { status: 429 })) as unknown as typeof fetch,
		});
		expect(await p("x")).toEqual({ ok: false, kind: "rate_limited" });
	});
});
