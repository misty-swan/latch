/**
 * 直近のベクトルの控え(recent_vectors・#47・設計 2026-10-25 §1.2〜§1.3)。
 * Layer 2 Candidate Retrievalの照会(Vectorize)が古い状態を返して相手を見落とすことがあるため、
 * 新しく計算した埋め込みを15分(PIPELINE.RECENT_VECTOR_TTL_MS)だけD1にも控える。
 * ベクトルはfloat32の並び(リトルエンディアン・1,024次元で4,096バイト)のBLOBで持つ。
 * 評価(evaluate.ts)はLayer 2 Candidate Retrievalの照会の直後に控えを読み(loadRecentVectors)、
 * 照会の結果に無い相手だけを類似度で混ぜる(mergeSupplement・設計 §1.4)。
 */
import { PIPELINE } from "@latch/shared";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { intents, recentVectors } from "../db/schema";
import { createLogger } from "../logging/logger";
import { cosineSimilarity } from "../vectorstore/similarity";
import { errorCodeOf } from "./errors";

const logger = createLogger();

/** ベクトルをfloat32の並びのバイト列にする(精度はfloat32へ丸まる) */
export const encodeVector = (values: number[]): ArrayBuffer =>
	Float32Array.from(values).buffer;

/**
 * BLOBからベクトルへ戻す。D1(drizzleのbuffer)からはUint8Array(Buffer)で返り、
 * 位置(byteOffset)が4の倍数とは限らないため、該当範囲を複製してから読む
 */
export const decodeVector = (blob: ArrayBuffer | Uint8Array): number[] => {
	const bytes =
		blob instanceof Uint8Array
			? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
			: blob;
	return Array.from(new Float32Array(bytes));
};

/**
 * 控えを書く(同じintent_idは上書き)。例外は外へ出さない。失敗しても補いが無いだけで
 * 従来の動作に戻るため、第1段の失敗にはせずログ(pipeline.recent_vector.failed)だけを残す
 */
export const saveRecentVector = async (
	db: D1Database,
	intentId: string,
	embeddedAt: Date,
	values: number[],
): Promise<void> => {
	try {
		const vector = Buffer.from(encodeVector(values));
		await drizzle(db)
			.insert(recentVectors)
			.values({ intentId, embeddedAt, vector })
			.onConflictDoUpdate({
				target: recentVectors.intentId,
				set: { embeddedAt, vector },
			});
	} catch (error) {
		logger.warn("pipeline.recent_vector.failed", {
			intent_id: intentId,
			error_code: errorCodeOf(error),
		});
	}
};

/** 埋め込みから15分を過ぎた控え(embedded_at < now − RECENT_VECTOR_TTL_MS)を消し、消した件数を返す */
export const deleteExpiredRecentVectors = async (
	db: D1Database,
	now: Date,
): Promise<number> => {
	const cutoff = new Date(now.getTime() - PIPELINE.RECENT_VECTOR_TTL_MS);
	const result = await drizzle(db)
		.delete(recentVectors)
		.where(lt(recentVectors.embeddedAt, cutoff));
	return result.meta.changes ?? 0;
};

/**
 * 評価で補う控えを読む(設計 §1.4の1)。intentsと結合し、起点と同じform・status='active'・
 * 埋め込みから15分以内(embedded_at ≥ now − RECENT_VECTOR_TTL_MS)・自分以外で、控えの embedded_at が
 * intents.embedded_at と等しい(現在の版の埋め込みである)行を、
 * 埋め込みの新しい順にlimit件まで返す。照会の結果との重複はmergeSupplementが除く。
 * 例外はそのまま投げる(呼び出し側が補いなしで続ける)
 */
export const loadRecentVectors = async (
	db: D1Database,
	opts: {
		form: NonNullable<(typeof intents.$inferSelect)["form"]>;
		selfId: string;
		now: Date;
		limit: number;
	},
): Promise<{ id: string; values: number[] }[]> => {
	const cutoff = new Date(opts.now.getTime() - PIPELINE.RECENT_VECTOR_TTL_MS);
	const rows = await drizzle(db)
		.select({ id: recentVectors.intentId, vector: recentVectors.vector })
		.from(recentVectors)
		.innerJoin(intents, eq(intents.id, recentVectors.intentId))
		.where(
			and(
				eq(intents.form, opts.form),
				eq(intents.status, "active"),
				gte(recentVectors.embeddedAt, cutoff),
				// 現在の版の埋め込みだけを使う(内容の変更でintents.embedded_atが消えた・別の時刻で
				// 埋め込み直された意思の、古い版の控えを補わない)
				eq(intents.embeddedAt, recentVectors.embeddedAt),
				ne(recentVectors.intentId, opts.selfId),
			),
		)
		.orderBy(desc(recentVectors.embeddedAt), recentVectors.intentId)
		.limit(opts.limit);
	return rows.map((row) => ({ id: row.id, values: decodeVector(row.vector) }));
};

/** score降順・同点はid昇順(evaluate.ts・インメモリVectorStoreと同じ規律) */
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
 * 照会の結果(hits)に控え(recent)を混ぜる(設計 §1.4の2・4)。hitsに無いidだけを、
 * 起点のベクトル(own)とのコサイン類似度(照会と同じ尺度)で加え、score降順・同点はid昇順に
 * 並べてtopKで切る。ownと次元の違う行(モデルの変更の後に残った行など)は読み飛ばす。
 * supplementedは切った後に残った補いの件数
 */
export const mergeSupplement = (
	hits: { id: string; score: number }[],
	recent: { id: string; values: number[] }[],
	own: number[],
	topK: number,
): { hits: { id: string; score: number }[]; supplemented: number } => {
	const seen = new Set(hits.map((hit) => hit.id));
	const added = new Set<string>();
	const merged = [...hits];
	for (const row of recent) {
		if (seen.has(row.id) || row.values.length !== own.length) {
			continue;
		}
		seen.add(row.id);
		added.add(row.id);
		merged.push({ id: row.id, score: cosineSimilarity(own, row.values) });
	}
	// 補いが無ければ照会の結果をそのまま返す(並びも従来どおり)
	if (added.size === 0) {
		return { hits, supplemented: 0 };
	}
	const kept = merged.sort(byScoreDescThenIdAsc).slice(0, topK);
	return {
		hits: kept,
		supplemented: kept.filter((hit) => added.has(hit.id)).length,
	};
};
