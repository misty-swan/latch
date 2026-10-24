/**
 * LLM動作モードの解決と3系統の束ね(docs/07 §2)。
 * LATCH_LLM_MODE=stub|real。既定stubで、未設定・不正値もstubに倒す(安全側)。
 * realはParser=Anthropic・Jev=TypeSafe(primary)+Anthropic(fallback)。各呼び出しの直前に
 * 外部送信の日次集計を加算する(08 §5・成否を問わず送った回数)。
 */
import type { Clock } from "../clock/clock";
import { type ExternalSendKey, recordExternalSend } from "./external-send";
import { anthropicJev } from "./real/jev-anthropic";
import { typesafeJev } from "./real/jev-typesafe";
import { realParser } from "./real/parser";
import { stubEmbedding } from "./stub/embedding";
import { stubJev } from "./stub/jev";
import { stubParse } from "./stub/parser";
import type { JevFn, Llm, LlmMode, ParserOutcome } from "./types";

/** 環境変数値をLlmModeへ解決する。未設定・不正値(前後空白を含む)は既定のstub(07 §2) */
export const resolveLlmMode = (v: string | undefined): LlmMode => {
	if (v === "stub" || v === "real") {
		return v;
	}
	return "stub";
};

/** 3系統(Parser/Embedding/Jev)の実装を束ねる。clockは構築時に注入する(04 §4の時刻規律) */
export const createLlm = (env: Env, clock: Clock): Llm => {
	const mode = resolveLlmMode(env.LATCH_LLM_MODE);
	if (mode === "real") {
		// 引数のEnvはwrangler生成の型で秘密値を持たないため、キーだけ読み替える(env.tsのEnvと同名)
		const secrets = env as Env & {
			ANTHROPIC_API_KEY?: string;
			TYPESAFE_API_KEY?: string;
		};
		const anthropicKey = secrets.ANTHROPIC_API_KEY;
		const typesafeKey = secrets.TYPESAFE_API_KEY;
		if (!anthropicKey || !typesafeKey) {
			throw new Error(
				"ENV_MISSING_LLM_KEY: LATCH_LLM_MODE=realではANTHROPIC_API_KEYとTYPESAFE_API_KEYが必須",
			);
		}
		const counted =
			<A, R>(key: ExternalSendKey, fn: (a: A) => Promise<R>) =>
			async (arg: A): Promise<R> => {
				await recordExternalSend(env.DB, clock, key);
				return fn(arg);
			};
		const parser: (raw_text: string) => Promise<ParserOutcome> = counted(
			"anthropic:parser",
			realParser({ apiKey: anthropicKey, clock }),
		);
		const primary: JevFn = counted(
			"typesafe:jev",
			typesafeJev({ apiKey: typesafeKey }),
		);
		const fallback: JevFn = counted(
			"anthropic:jev",
			anthropicJev({ apiKey: anthropicKey }),
		);
		return {
			parser,
			embedding: stubEmbedding,
			jev: { primary, fallback },
		};
	}
	return {
		parser: async (raw_text) => ({
			ok: true,
			output: stubParse(raw_text, clock),
		}),
		embedding: stubEmbedding,
		jev: { primary: stubJev, fallback: stubJev },
	};
};
