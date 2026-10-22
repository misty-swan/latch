/**
 * VectorStoreのVectorize実装(staging/prod用)。
 * env.VECTORSへの薄いラップのみで、変換・再検証ロジックは持たない
 * (docs/05 §2.3・docs/06 Layer 2 Candidate Retrieval)。metadataの正は
 * Vectorizeに置かず、取り出し後の再検証はD1の現行値で行う(二重化)。
 */
import type { StoredVector, VectorStore } from "./types";

/**
 * Vectorizeへ書き込むmetadata(docs/05 §2.3)。
 * Vectorizeのmetadata型はnullを許さないため、未確定のcategory(null)は
 * キーごと除外する。queryのfilterはform・statusのみでcategoryを使わず、
 * 取り出し後の再検証はD1の現行値で行うため影響しない。
 */
const toVectorizeMetadata = (
	m: StoredVector["metadata"],
): Record<string, string | number> => {
	const metadata: Record<string, string | number> = {
		form: m.form,
		status: m.status,
		user_id: m.user_id,
	};
	if (m.category !== null) {
		metadata.category = m.category;
	}
	if (m.version !== undefined) {
		metadata.version = m.version;
	}
	return metadata;
};

/** Vectorizeから取り出した値をStoredVectorへ組み立てる(category不在はnullへ復元) */
const toStoredVector = (v: {
	id: string;
	values: VectorFloatArray | number[];
	metadata?: Record<string, unknown>;
}): StoredVector => {
	const meta = v.metadata ?? {};
	return {
		id: v.id,
		values: v.values as number[],
		metadata: {
			form: meta.form as string,
			status: meta.status as string,
			category: (meta.category as string | undefined) ?? null,
			user_id: meta.user_id as string,
			version: typeof meta.version === "number" ? meta.version : undefined,
		},
	};
};

/** Vectorizeインデックス(env.VECTORS)をVectorStoreインターフェースへラップする */
export const createVectorizeStore = (vectors: VectorizeIndex): VectorStore => ({
	upsert: async (stored) => {
		await vectors.upsert(
			stored.map((v) => ({
				id: v.id,
				values: v.values,
				metadata: toVectorizeMetadata(v.metadata),
			})),
		);
	},
	query: async (vector, opts) => {
		// returnMetadataは指定しない(id/scoreのみ使う)。filterは完全一致の
		// $eqへ組み立てる(Vectorizeのmetadata filter・docs/06 Layer 2)
		const result = await vectors.query(vector, {
			topK: opts.topK,
			filter: {
				form: { $eq: opts.filter.form },
				status: { $eq: opts.filter.status },
			},
		});
		return result.matches.map((m) => ({ id: m.id, score: m.score }));
	},
	getByIds: async (ids) => {
		// Vectorizeは見つかった分だけ返すため、id→ベクトルのMapへ置いて
		// 入力順・不在nullの契約に揃える
		const found = await vectors.getByIds(ids);
		const byId = new Map(found.map((v) => [v.id, v]));
		return ids.map((id) => {
			const v = byId.get(id);
			if (v === undefined || v.values === undefined) {
				return null;
			}
			return toStoredVector(v);
		});
	},
	deleteByIds: async (ids) => {
		await vectors.deleteByIds(ids);
	},
});
