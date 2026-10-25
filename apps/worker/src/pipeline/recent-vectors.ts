/**
 * 直近のベクトルの控え(recent_vectors・#47・設計 2026-10-25 §1.2〜§1.3)。
 * Layer 2 Candidate Retrievalの照会(Vectorize)が古い状態を返して相手を見落とすことがあるため、
 * 新しく計算した埋め込みを15分(PIPELINE.RECENT_VECTOR_TTL_MS)だけD1にも控える。
 * ベクトルはfloat32の並び(リトルエンディアン・1,024次元で4,096バイト)のBLOBで持つ。
 * 評価(evaluate.ts)はLayer 2 Candidate Retrievalの照会と同時に控えのidと時刻だけを読み
 * (loadRecentVectorRefs)、照会の結果に無い相手があるときだけそのベクトルを読んで
 * (loadRecentVectorValues)、類似度で混ぜる(mergeSupplement・設計 §1.4)。
 */
import { PIPELINE } from "@latch/shared";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
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

/** 控えの行の識別(意思のidと控えの埋め込みの時刻) */
export interface RecentVectorRef {
	id: string;
	embeddedAt: Date;
}

/** 補いの読み込みが使う起点の意思の項目 */
export type RecentVectorOrigin = Pick<
	typeof intents.$inferSelect,
	"id" | "userId" | "form" | "startsAt" | "endsAt" | "expiresAt"
>;

/**
 * 機会Intentどうしの時間の重なりが15分未満の相手を除く条件(LAT-99)。Layer 1のtime_no_overlap
 * (layer1.tsのtimeOverlapMs)と同じ式で、終端はends_atを優先し無ければexpires_at。起点か相手の
 * どちらかで判定できない(starts_atか終端がnull)ときはLayer 1と同じく除かない。つながりIntentでは
 * 条件を付けない(undefined)
 */
const timeOverlapCondition = (origin: RecentVectorOrigin): SQL | undefined => {
	const originEnd = origin.endsAt ?? origin.expiresAt;
	if (
		origin.form !== "occasion" ||
		origin.startsAt === null ||
		originEnd === null
	) {
		return undefined;
	}
	const candidateEnd = sql`coalesce(${intents.endsAt}, ${intents.expiresAt})`;
	return or(
		isNull(intents.startsAt),
		sql`${candidateEnd} is null`,
		sql`min(${candidateEnd}, ${originEnd.getTime()}) - max(${intents.startsAt}, ${origin.startsAt.getTime()}) >= ${PIPELINE.TIME_OVERLAP_MIN_MS}`,
	);
};

/**
 * 評価で補う控えの候補を読む(設計 §1.4の1)。intentsと結合し、起点と同じform・status='active'・
 * 埋め込みから15分以内(embedded_at ≥ now − RECENT_VECTOR_TTL_MS)・自分以外で、控えの embedded_at が
 * intents.embedded_at と等しい(現在の版の埋め込みである)行を、
 * 埋め込みの新しい順にlimit件まで返す。Layer 1で必ず不合格になる相手(同じ利用者=self_pair・
 * 機会Intentの時間の重なり15分未満=time_no_overlap)は先に除き、limit件の枠を見込みのある相手に
 * 使う(LAT-99。Layer 1の判定の結果は変わらない)。ベクトル(BLOB)は読まない: D1のJSのAPIはBLOBを
 * 数値の配列で返すため1行で約15KBになり、照会の結果に既にある相手(普段はほぼ全部)の分まで毎回読むと
 * 通信が評価1回あたり約0.75MBになる。ベクトルは照会の結果に無いidだけをloadRecentVectorValuesで読む。
 * 例外はそのまま投げる(呼び出し側が補いなしで続ける)
 */
export const loadRecentVectorRefs = async (
	db: D1Database,
	opts: {
		origin: RecentVectorOrigin;
		now: Date;
		limit: number;
	},
): Promise<RecentVectorRef[]> => {
	const { origin } = opts;
	if (origin.form === null) {
		return [];
	}
	const cutoff = new Date(opts.now.getTime() - PIPELINE.RECENT_VECTOR_TTL_MS);
	return drizzle(db)
		.select({
			id: recentVectors.intentId,
			embeddedAt: recentVectors.embeddedAt,
		})
		.from(recentVectors)
		.innerJoin(intents, eq(intents.id, recentVectors.intentId))
		.where(
			and(
				eq(intents.form, origin.form),
				eq(intents.status, "active"),
				gte(recentVectors.embeddedAt, cutoff),
				// 現在の版の埋め込みだけを使う(内容の変更でintents.embedded_atが消えた・別の時刻で
				// 埋め込み直された意思の、古い版の控えを補わない)
				eq(intents.embeddedAt, recentVectors.embeddedAt),
				ne(recentVectors.intentId, origin.id),
				ne(intents.userId, origin.userId),
				timeOverlapCondition(origin),
			),
		)
		.orderBy(desc(recentVectors.embeddedAt), recentVectors.intentId)
		.limit(opts.limit);
};

/** 照会の結果(hits)に無い控えの候補だけを、候補の並び(新しい順)のまま返す */
export const refsMissingFromHits = (
	refs: RecentVectorRef[],
	hits: { id: string }[],
): RecentVectorRef[] => {
	const seen = new Set(hits.map((hit) => hit.id));
	return refs.filter((ref) => !seen.has(ref.id));
};

/** in句の幅(D1の照会のチャンク化の慣習・docs/06 §3の100件チャンク) */
const VALUE_CHUNK = 100;

/**
 * 控えの候補(refs)のベクトルを読む(2回目の読み込み)。1回目の後に控えが上書きされた行
 * (embedded_atが変わった行)と消えた行は返さない。並びはrefsの順。refsが空ならD1を読まない。
 * 例外はそのまま投げる(呼び出し側が補いなしで続ける)
 */
export const loadRecentVectorValues = async (
	db: D1Database,
	refs: RecentVectorRef[],
): Promise<{ id: string; values: number[] }[]> => {
	if (refs.length === 0) {
		return [];
	}
	const ids = refs.map((ref) => ref.id);
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += VALUE_CHUNK) {
		chunks.push(ids.slice(i, i + VALUE_CHUNK));
	}
	const results = await Promise.all(
		chunks.map((chunk) =>
			drizzle(db)
				.select({
					id: recentVectors.intentId,
					embeddedAt: recentVectors.embeddedAt,
					vector: recentVectors.vector,
				})
				.from(recentVectors)
				.where(inArray(recentVectors.intentId, chunk)),
		),
	);
	const byId = new Map(results.flat().map((row) => [row.id, row]));
	const out: { id: string; values: number[] }[] = [];
	for (const ref of refs) {
		const row = byId.get(ref.id);
		if (
			row === undefined ||
			row.embeddedAt.getTime() !== ref.embeddedAt.getTime()
		) {
			continue;
		}
		out.push({ id: ref.id, values: decodeVector(row.vector) });
	}
	return out;
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
