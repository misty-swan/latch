/**
 * VectorStoreの実装選択(docs/10の環境方針)。
 * LATCH_ENV=local(vitest・wrangler dev --local・E2E)ではインメモリ実装、
 * それ以外(staging/prod)ではenv.VECTORS(Vectorize)のラップを使う。
 * Vectorizeにはローカルシミュレータが存在しないための二実装構成。
 */
import type { Env } from "../env";
import { memoryVectorStore } from "./memory";
import type { StoredVector, VectorStore } from "./types";
import { createVectorizeStore } from "./vectorize";

/** 実行環境に応じたVectorStore実装を返す */
export const createVectorStore = (env: Env): VectorStore => {
	if (env.LATCH_ENV === "local") {
		return memoryVectorStore();
	}
	return createVectorizeStore(env.VECTORS);
};

export type { StoredVector, VectorStore };
