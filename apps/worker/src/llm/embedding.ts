/**
 * Embeddingのモード解決と束ね(docs/07 §2・§4)。
 * LATCH_EMBEDDING_MODE=stub|real。EmbeddingだけはF3でreal(Workers AI bge-m3)へ
 * 接続できるため、Parser/JevのLATCH_LLM_MODEとは独立に切り替える。
 * 既定stubで、未設定・不正値もstubに倒す(resolveLlmModeと同じ規則・07 §2)。
 * realはtimeout 5秒・呼び出しの中では再試行しない(07 §4)。失敗はキューのメッセージの
 * retry(10秒・30秒・60秒)でやり直し、使い切ったものは06 §5のバックフィルで回収する。
 */
import {
	EMBEDDING_MODEL_REAL,
	EMBEDDING_MODEL_STUB,
	PIPELINE,
} from "@latch/shared";
import type { Env } from "../env";
import { stubEmbedding } from "./stub/embedding";

/** Embeddingの実装。modelIdはintents.embedding_modelへ記録する識別子(07 §4) */
export interface Embedder {
	embed: (input: string) => Promise<number[]>;
	modelId: string;
}

/** 環境変数値をEmbeddingの動作モードへ解決する。未設定・不正値(前後空白を含む)は既定のstub(07 §2) */
export const resolveEmbeddingMode = (
	v: string | undefined,
): "stub" | "real" => {
	if (v === "stub" || v === "real") {
		return v;
	}
	return "stub";
};

/**
 * Workers AI応答からembeddingベクトルを取り出す(07 §4)。bge-m3の生成型は
 * query検索等の応答も含むユニオンのため、data配列の有無で構造的に絞り込む。
 * 形状が違う応答はembedding失敗として扱う(06 §5のバックフィルで回収)。
 */
const extractEmbeddingVector = (result: Ai_Cf_Baai_Bge_M3_Output): number[] => {
	if (!("data" in result) || result.data === undefined) {
		throw new Error(
			"EMBEDDING_UNEXPECTED_RESPONSE: Workers AI応答にdata配列がない(07 §4)",
		);
	}
	return result.data[0];
};

/** Embeddingの実装を束ねる(07 §2・§4)。stub=決定的擬似ベクトル・real=Workers AI */
export const createEmbedder = (env: Env): Embedder => {
	const mode = resolveEmbeddingMode(env.LATCH_EMBEDDING_MODE);
	if (mode === "stub") {
		return { embed: stubEmbedding, modelId: EMBEDDING_MODEL_STUB };
	}
	// 設定エラー(realなのにAIバインディングがない)は構築時に早期failする
	if (env.AI === undefined) {
		throw new Error(
			"AI_BINDING_MISSING: LATCH_EMBEDDING_MODE=realにはAIバインディングが必須(07 §1)",
		);
	}
	const ai = env.AI;
	return {
		modelId: EMBEDDING_MODEL_REAL,
		embed: async (input: string): Promise<number[]> => {
			// timeout 5秒・呼び出しの中では再試行しない(07 §4)。タイマー洩れを避けるためrace確定後に解除する
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return extractEmbeddingVector(
					await Promise.race([
						ai.run(EMBEDDING_MODEL_REAL, { text: [input] }),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => {
								reject(
									new Error(
										"EMBEDDING_TIMEOUT: Embeddingが5秒でタイムアウト(07 §4・呼び出しの中では再試行しない・キューのやり直しの後は06 §5のバックフィル)",
									),
								);
							}, PIPELINE.EMBEDDING_TIMEOUT_MS);
						}),
					]),
				);
			} finally {
				clearTimeout(timer);
			}
		},
	};
};
