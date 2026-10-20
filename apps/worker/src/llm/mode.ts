/**
 * LLM動作モードの解決と3系統の束ね(docs/07 §2)。
 * LATCH_LLM_MODE=stub|real。既定stubで、未設定・不正値もstubに倒す(安全側)。
 * realは精度ゲート(07 §6)合格後に接続するため、現時点では例外とする。
 */
import type { Clock } from "../clock/clock";
import { stubEmbedding } from "./stub/embedding";
import { stubJev } from "./stub/jev";
import { stubParse } from "./stub/parser";
import type { Llm, LlmMode } from "./types";

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
		throw new Error(
			"LLM_REAL_NOT_IMPLEMENTED: realは精度ゲート(07 §6)合格後に接続する",
		);
	}
	return {
		parser: (raw_text) => stubParse(raw_text, clock),
		embedding: stubEmbedding,
		jev: { primary: stubJev, fallback: stubJev },
	};
};
