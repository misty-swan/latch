/**
 * VectorStoreのインメモリ実装(LATCH_ENV=local専用・docs/10の環境方針)。
 * Vectorizeにはローカルシミュレータが存在しないため、同一インターフェースで
 * 置き換える。モジュール内Mapの単一インスタンス(シングルトン)を返し、
 * E2E(wrangler dev)でfetch・Queues消費・Cronが同一isolate内の状態を共有する。
 * staging/prodでは使わない(env.VECTORSのVectorize実装を使う・index.ts)。
 */
import { cosineSimilarity } from "./similarity";
import type { StoredVector, VectorStore } from "./types";

/** シングルトンの実体(モジュール内Map) */
const store = new Map<string, StoredVector>();

/**
 * 試験専用: 反映の遅れ(Vectorizeはupsertが数秒後に見える)を再現する保留。
 * hold中のupsertはpendingに溜まり、query・getByIdsから見えない
 */
const pending = new Map<string, StoredVector>();
let holding = false;

/** score降順・同点はid昇順(メモリ実装の結果順を決定的に保つ) */
const byScoreDescThenIdAsc = (
	a: { id: string; score: number },
	b: { id: string; score: number },
): number => {
	if (a.score !== b.score) {
		return b.score - a.score;
	}
	if (a.id === b.id) {
		return 0;
	}
	return a.id < b.id ? -1 : 1;
};

/**
 * インメモリVectorStore(モジュール内Mapを閉じ込めた単一インスタンス)。
 * モジュールレベルで1回だけ生成し、memoryVectorStore()は常に同一オブジェクトを返す。
 */
const singleton: VectorStore = {
	upsert: async (vectors) => {
		// 同一idは上書き(Vectorizeのupsertと同じセマンティクス)
		for (const v of vectors) {
			(holding ? pending : store).set(v.id, v);
		}
	},
	query: async (vector, opts) => {
		const hits: { id: string; score: number }[] = [];
		for (const v of store.values()) {
			// filterはform・statusの完全一致(両方一致するベクトルのみ)
			if (
				v.metadata.form !== opts.filter.form ||
				v.metadata.status !== opts.filter.status
			) {
				continue;
			}
			hits.push({ id: v.id, score: cosineSimilarity(vector, v.values) });
		}
		hits.sort(byScoreDescThenIdAsc);
		return hits.slice(0, opts.topK);
	},
	getByIds: async (ids) =>
		// 不在のidはnull・入力順を保持(VectorizeのgetByIdsは在る分だけ返すため、
		// この実装の契約(不在=null)に揃えている)
		ids.map((id) => store.get(id) ?? null),
	deleteByIds: async (ids) => {
		for (const id of ids) {
			store.delete(id);
			// 保留中の書き込みも捨てる(解放で削除済みのベクトルが蘇らないように)
			pending.delete(id);
		}
	},
};

/** インメモリVectorStoreの単一インスタンスを返す(E2Eのisolate内で状態を共有する) */
export const memoryVectorStore = (): VectorStore => singleton;

/**
 * インメモリ実装の中身を空にする(テスト間の汚染除去用)。
 * 実装ファイルからのみexportし、index.tsからは再exportしない。
 */
export const resetMemoryVectorStore = (): void => {
	store.clear();
	pending.clear();
	holding = false;
};

/** 試験専用: 以降のupsertを保留する(query・getByIdsから見えない)。index.tsからは再exportしない */
export const holdMemoryVectorWrites = (): void => {
	holding = true;
};

/** 試験専用: 保留を解いて保留中のupsertを反映する */
export const releaseMemoryVectorWrites = (): void => {
	holding = false;
	for (const [id, v] of pending) {
		store.set(id, v);
	}
	pending.clear();
};
