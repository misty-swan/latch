/**
 * Anthropic Messages APIの呼び出し部品(設計書§0.4・§4.1・§5.2)。
 * SDKは使わずfetchで直接呼び、構造化出力(output_config.format)のJSONを受け取る。
 * 時間切れ・失敗の種別の写像をここ1か所に持ち、例外を投げずに結果を返す(07 §5の作法)。
 * 呼び出しの中では再試行しない(07 §3・§5)。
 */
import type { LlmFailureKind } from "../types";
import { ANTHROPIC_MODEL } from "./prompts";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** APIの版(anthropic-versionヘッダ)。2026-10-21版はサンプリングの引数を送らない要求で使える */
export const ANTHROPIC_VERSION = "2026-10-21";

/** 出力の上限トークン。ParserのJSON・Jevの7軸の数値に足りる値 */
const MAX_TOKENS = 2048;

export type AnthropicJsonResult =
	| { ok: true; value: unknown }
	| { ok: false; kind: LlmFailureKind };

/**
 * HTTPの失敗応答を種別へ写す。429=rate_limited・503/529またはoverloaded_error=overloaded・
 * 他の5xx=unavailable・他=other(400番台は切り替えても直らない)
 */
const classifyHttpFailure = async (res: Response): Promise<LlmFailureKind> => {
	if (res.status === 429) return "rate_limited";
	if (res.status === 529 || res.status === 503) return "overloaded";
	try {
		const body = (await res.json()) as { error?: { type?: unknown } };
		if (body?.error?.type === "overloaded_error") return "overloaded";
	} catch {
		// 本文が読めない失敗は状態だけで分類する
	}
	return res.status >= 500 ? "unavailable" : "other";
};

/** 応答本文から最初のtextブロックの文字列を取り出す。無ければnull */
const firstText = (body: unknown): string | null => {
	const content = (body as { content?: unknown })?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			return (block as { text: string }).text;
		}
	}
	return null;
};

/**
 * system文とuser文を送り、schemaに従うJSONを受け取る。
 * timeoutMsを過ぎたらAbortSignalで打ち切ってtimeoutを返す
 */
export const callAnthropicJson = async (args: {
	apiKey: string;
	system: string;
	user: string;
	schema: object;
	timeoutMs: number;
	fetchFn?: typeof fetch;
}): Promise<AnthropicJsonResult> => {
	const fetchFn = args.fetchFn ?? fetch;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, args.timeoutMs);

	try {
		const res = await fetchFn(ANTHROPIC_MESSAGES_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": args.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify({
				model: ANTHROPIC_MODEL,
				max_tokens: MAX_TOKENS,
				// 短いJSONを返すだけの判定のため思考を止め、時間と費用を抑える
				thinking: { type: "disabled" },
				system: args.system,
				messages: [{ role: "user", content: args.user }],
				output_config: {
					format: { type: "json_schema", schema: args.schema },
				},
			}),
			signal: controller.signal,
		});

		if (!res.ok) return { ok: false, kind: await classifyHttpFailure(res) };

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			// 本文の読み取り中の打ち切りはtimeout・それ以外は応答の形の誤り
			return { ok: false, kind: timedOut ? "timeout" : "invalid_output" };
		}

		// 上限で切れた・拒否された出力はスキーマどおりとは限らない
		const stopReason = (body as { stop_reason?: unknown })?.stop_reason;
		if (stopReason === "max_tokens" || stopReason === "refusal") {
			return { ok: false, kind: "invalid_output" };
		}

		const text = firstText(body);
		if (text === null) return { ok: false, kind: "invalid_output" };
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			return { ok: false, kind: "invalid_output" };
		}
	} catch {
		// fetchの例外: 時間切れによる打ち切りはtimeout・それ以外の通信の失敗はunavailable
		return { ok: false, kind: timedOut ? "timeout" : "unavailable" };
	} finally {
		clearTimeout(timer);
	}
};
