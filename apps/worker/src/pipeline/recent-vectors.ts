/**
 * 直近のベクトルの控え(recent_vectors・#47・設計 2026-10-25 §1.2〜§1.3)。
 * Layer 2 Candidate Retrievalの照会(Vectorize)が古い状態を返して相手を見落とすことがあるため、
 * 新しく計算した埋め込みを15分(PIPELINE.RECENT_VECTOR_TTL_MS)だけD1にも控える。
 * ベクトルはfloat32の並び(リトルエンディアン・1,024次元で4,096バイト)のBLOBで持つ。
 */
import { PIPELINE } from "@latch/shared";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { recentVectors } from "../db/schema";
import { createLogger } from "../logging/logger";
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
