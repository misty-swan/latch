/**
 * VectorStoreのインターフェース(docs/05 §2.3・docs/06 Layer 2 Candidate Retrieval)。
 * Vectorizeにはローカルシミュレータが存在しないため、local環境(vitest・
 * wrangler dev --local・E2E)ではインメモリ実装を、staging/prodでは
 * env.VECTORSのラップを使う(実装の選択はindex.ts)。
 */

/**
 * Vectorizeに格納するベクトル(docs/05 §2.3)。
 * id= Intent ULID・metadata= {form, status, category, user_id}。
 */
export interface StoredVector {
	id: string;
	values: number[];
	metadata: {
		form: string;
		status: string;
		category: string | null;
		user_id: string;
		/** upsert時点のIntent version。反映確認(同version以上か)に使う。不在はundefined */
		version?: number;
	};
}

/**
 * ベクトル類似ストアの共通インターフェース。
 * queryはコサイン類似度の降順でtopK件を返す。filterはform・statusの完全一致
 * (両方一致するベクトルのみ対象・docs/06 Layer 2の最適化filter)。
 * 自己idの除外は呼び出し側(Layer 1以降)が担う。
 */
export interface VectorStore {
	upsert(vectors: StoredVector[]): Promise<void>;
	query(
		vector: number[],
		opts: { topK: number; filter: { form: string; status: string } },
	): Promise<{ id: string; score: number }[]>;
	/** 指定idのベクトルを入力順のまま返す。不在のidはnull */
	getByIds(ids: string[]): Promise<(StoredVector | null)[]>;
	deleteByIds(ids: string[]): Promise<void>;
}
