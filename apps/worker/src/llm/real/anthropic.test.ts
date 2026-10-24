import { CATEGORIES } from "@latch/shared";
import { describe, expect, it } from "vitest";
import { JEV_AXES } from "../types";
import { ANTHROPIC_VERSION, callAnthropicJson } from "./anthropic";
import {
	ANTHROPIC_MODEL,
	JEV_ANTHROPIC_SYSTEM_PROMPT,
	JEV_OUTPUT_SCHEMA,
	JEV_QUESTIONS,
	PARSER_OUTPUT_SCHEMA,
	PARSER_SYSTEM_PROMPT,
	TYPESAFE_MODEL,
} from "./prompts";

/** 試験用の偽キー(本物の鍵は書かない) */
const FAKE_KEY = "test-anthropic-key";

const SCHEMA = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** 成功時のMessages APIの応答の形(content配列のtextにJSON文字列) */
const messageBody = (text: string, stop_reason = "end_turn") => ({
	id: "msg_test",
	type: "message",
	role: "assistant",
	model: ANTHROPIC_MODEL,
	content: [{ type: "text", text }],
	stop_reason,
	usage: { input_tokens: 1, output_tokens: 1 },
});

/** 固定の応答を返す差し替えのfetch。送られた要求を記録する */
const fixedFetch = (make: () => Response | Promise<Response>) => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return make();
	}) as typeof fetch;
	return { fn, calls };
};

const call = (fetchFn: typeof fetch, timeoutMs = 1000) =>
	callAnthropicJson({
		apiKey: FAKE_KEY,
		system: "SYSTEM",
		user: "USER",
		schema: SCHEMA,
		timeoutMs,
		fetchFn,
	});

describe("callAnthropicJson(設計書§4.1・07 §3/§5)", () => {
	it("要求にx-api-key・anthropic-version・固定モデル・output_config.formatが載る", async () => {
		const { fn, calls } = fixedFetch(() =>
			jsonResponse(200, messageBody('{"answer":"ok"}')),
		);
		await call(fn);
		expect(calls).toHaveLength(1);
		const [{ url, init }] = calls;
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(init.method).toBe("POST");
		const headers = new Headers(init.headers);
		expect(headers.get("x-api-key")).toBe(FAKE_KEY);
		expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
		expect(headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(String(init.body));
		expect(body.model).toBe(ANTHROPIC_MODEL);
		expect(body.system).toBe("SYSTEM");
		expect(body.messages).toEqual([{ role: "user", content: "USER" }]);
		expect(body.output_config.format).toEqual({
			type: "json_schema",
			schema: SCHEMA,
		});
		expect(typeof body.max_tokens).toBe("number");
		// 要求はAbortSignalで時間切れを持つ
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("200で本文のtextがJSON → ok:true・value", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, messageBody('{"answer":"はい"}')),
		);
		expect(await call(fn)).toEqual({ ok: true, value: { answer: "はい" } });
	});

	it("textブロックの前に別種のブロックがあってもtextを読む", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, {
				...messageBody('{"answer":"x"}'),
				content: [
					{ type: "thinking", thinking: "", signature: "s" },
					{ type: "text", text: '{"answer":"x"}' },
				],
			}),
		);
		expect(await call(fn)).toEqual({ ok: true, value: { answer: "x" } });
	});

	it("429 → rate_limited", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(429, {
				type: "error",
				error: { type: "rate_limit_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "rate_limited" });
	});

	it("529 → overloaded", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(529, {
				type: "error",
				error: { type: "overloaded_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "overloaded" });
	});

	it("529以外の状態でもerror.typeがoverloaded_error → overloaded", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(503, {
				type: "error",
				error: { type: "overloaded_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "overloaded" });
	});

	it("timeoutMsを過ぎる → timeout(AbortSignalで打ち切る)", async () => {
		let aborted = false;
		const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new DOMException("aborted", "AbortError"));
				});
			})) as typeof fetch;
		expect(await call(fn, 20)).toEqual({ ok: false, kind: "timeout" });
		expect(aborted).toBe(true);
	});

	it("200でstop_reason:max_tokens → invalid_output", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, messageBody('{"answer":', "max_tokens")),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("200でstop_reason:refusal → invalid_output", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, messageBody("", "refusal")),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("200でJSONでない本文 → invalid_output", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, messageBody("JSONではない文")),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("200でtextブロックが無い → invalid_output", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(200, { ...messageBody("{}"), content: [] }),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it("200で応答全体がJSONでない → invalid_output", async () => {
		const { fn } = fixedFetch(() => new Response("<html>", { status: 200 }));
		expect(await call(fn)).toEqual({ ok: false, kind: "invalid_output" });
	});

	it.each([500, 502])("サーバー側の失敗%i → unavailable", async (status) => {
		const { fn } = fixedFetch(() =>
			jsonResponse(status, {
				type: "error",
				error: { type: "api_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "unavailable" });
	});

	it("503(overloaded_errorでない) → overloaded", async () => {
		const { fn } = fixedFetch(() =>
			jsonResponse(503, {
				type: "error",
				error: { type: "api_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "overloaded" });
	});

	it.each([400, 401, 404])("その他の状態%i → other", async (status) => {
		const { fn } = fixedFetch(() =>
			jsonResponse(status, {
				type: "error",
				error: { type: "api_error", message: "x" },
			}),
		);
		expect(await call(fn)).toEqual({ ok: false, kind: "other" });
	});

	it("通信の失敗(fetchの例外) → unavailable", async () => {
		const fn = (async () => {
			throw new TypeError("network");
		}) as typeof fetch;
		expect(await call(fn)).toEqual({ ok: false, kind: "unavailable" });
	});
});

describe("指示文とモデル名(設計書§0.4・§4.1・§5)", () => {
	it("モデル名はIDを固定する", () => {
		expect(ANTHROPIC_MODEL).toBe("claude-haiku-5-5");
		expect(TYPESAFE_MODEL).toBe("jev-1.14.0");
	});

	it("Parserのsystem文は現在時刻とカテゴリの一覧を含む", () => {
		const prompt = PARSER_SYSTEM_PROMPT("2026-10-24T09:00:00+09:00");
		expect(prompt).toContain("2026-10-24T09:00:00+09:00");
		for (const category of CATEGORIES) expect(prompt).toContain(category);
		expect(prompt).toContain('"field":"participants"');
		expect(prompt).toContain('"field":"geo"');
	});

	it("Parserの出力スキーマはコードで求める期限の選択肢を除くParserOutputのフィールドを必須にする", () => {
		expect([...PARSER_OUTPUT_SCHEMA.required].sort()).toEqual(
			[
				"alcohol_involved",
				"budget",
				"category",
				"form",
				"participants",
				"time",
				"topic",
				"warnings",
			].sort(),
		);
		expect(PARSER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
		expect(Object.keys(PARSER_OUTPUT_SCHEMA.properties)).not.toContain(
			"expires_at_options",
		);
	});

	it("Parserのsystem文は期限の選択肢をモデルに求めない(コードで求める)", () => {
		expect(PARSER_SYSTEM_PROMPT("2026-10-24T09:00:00+09:00")).not.toContain(
			"expires_at_options",
		);
	});

	it("Jevの問い・予備のsystem文・出力スキーマは7軸をそろえる", () => {
		expect(Object.keys(JEV_QUESTIONS).sort()).toEqual([...JEV_AXES].sort());
		for (const axis of JEV_AXES) {
			expect(JEV_QUESTIONS[axis].instructions).toContain("`intent_a`");
			expect(JEV_ANTHROPIC_SYSTEM_PROMPT).toContain(axis);
		}
		expect([...JEV_OUTPUT_SCHEMA.required].sort()).toEqual(
			[...JEV_AXES].sort(),
		);
		expect(JEV_OUTPUT_SCHEMA.additionalProperties).toBe(false);
	});
});
