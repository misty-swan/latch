/**
 * match_candidatesのupsertと行idの読み直し(docs/05 §2.2)。
 * 1対1(evaluate.ts)とPool内の全ペア(group-eval.ts・F4b設計 §2.4)で共用する。
 * 行はa<b正規化済みで渡す。UNIQUE(a,b,va,vb)の衝突はON CONFLICT DO UPDATEで
 * 再評価のスコアを上書きする(行は増やさない・status・jev_resultは保持)
 */
import { and, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { intents, matchCandidates } from "../db/schema";
import type { JevAxes } from "../llm/types";
import { errorCodeOf } from "./errors";
import { intentPairKey } from "./group";

/** 候補upsertの分割幅(13列×7行=91バインド・D1の上限100対策) */
const UPSERT_CHUNK_SIZE = 7;

/**
 * 読み直しの分割幅。1チャンクのa側・b側の相異なるidはそれぞれ行数以下のため、
 * 2つのin句の合計は最大96バインド(docs/06 §3の48件)
 */
const READ_CHUNK_SIZE = 48;

/** match_candidatesのUNIQUEキー(intent_a_id, intent_b_id, intent_a_version, intent_b_version)の文字列化 */
const candidateKey = (r: {
	intentAId: string;
	intentBId: string;
	intentAVersion: number;
	intentBVersion: number;
}): string =>
	`${r.intentAId}:${r.intentBId}:${r.intentAVersion}:${r.intentBVersion}`;

/** 読み直した行(バッチの結果の型) */
interface SavedRow {
	id: string;
	intentAId: string;
	intentBId: string;
	intentAVersion: number;
	intentBVersion: number;
	jevResult: unknown;
}

/**
 * 行をupsertし、UNIQUEキーで読み直した実際の行id(衝突時は既存行のid)と
 * jev_resultを返す。戻り値のキーはintentPairKey(intentAId, intentBId)
 */
const upsertAndReadRows = async (
	db: DrizzleD1Database,
	rows: (typeof matchCandidates.$inferInsert)[],
	now: Date,
): Promise<Map<string, { id: string; jevResult: JevAxes | null }>> => {
	const out = new Map<string, { id: string; jevResult: JevAxes | null }>();
	if (rows.length === 0) {
		return out;
	}
	const upserts: BatchItem<"sqlite">[] = [];
	for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
		upserts.push(
			db
				.insert(matchCandidates)
				.values(rows.slice(i, i + UPSERT_CHUNK_SIZE))
				.onConflictDoUpdate({
					target: [
						matchCandidates.intentAId,
						matchCandidates.intentBId,
						matchCandidates.intentAVersion,
						matchCandidates.intentBVersion,
					],
					set: {
						retrievalScore: sql`excluded.retrieval_score`,
						cheapJudgeScore: sql`excluded.cheap_judge_score`,
						// statusは上書きしない(新規INSERTの行だけがcandidateになり、
						// 提案済み・クローズ済みの既存行は状態を保つ)
						updatedAt: now,
					},
				}),
		);
	}

	// upsertは衝突時に既存行のidを保持するため、UNIQUEキーで読み直して実際の行idを得る。
	// in句は版を含まないため、版違いの行は完全キーの照合で除く
	const reads: BatchItem<"sqlite">[] = [];
	for (let i = 0; i < rows.length; i += READ_CHUNK_SIZE) {
		const chunk = rows.slice(i, i + READ_CHUNK_SIZE);
		reads.push(
			db
				.select({
					id: matchCandidates.id,
					intentAId: matchCandidates.intentAId,
					intentBId: matchCandidates.intentBId,
					intentAVersion: matchCandidates.intentAVersion,
					intentBVersion: matchCandidates.intentBVersion,
					jevResult: matchCandidates.jevResult,
				})
				.from(matchCandidates)
				.where(
					and(
						inArray(matchCandidates.intentAId, [
							...new Set(chunk.map((r) => r.intentAId)),
						]),
						inArray(matchCandidates.intentBId, [
							...new Set(chunk.map((r) => r.intentBId)),
						]),
					),
				),
		);
	}
	// upsertと読み直しを1つのバッチ(1往復・1トランザクション)で送る。読み直しはバッチ内で
	// upsertの後に並ぶため、upsert後の行を読む(D1の直列の待ちを1段にする・#36)
	const [first, ...rest] = [...upserts, ...reads];
	const results = await db.batch([first, ...rest]);
	const wanted = new Set(rows.map(candidateKey));
	for (const result of results.slice(upserts.length)) {
		for (const r of result as SavedRow[]) {
			if (!wanted.has(candidateKey(r))) {
				continue;
			}
			out.set(intentPairKey(r.intentAId, r.intentBId), {
				id: r.id,
				jevResult: (r.jevResult as JevAxes | null) ?? null,
			});
		}
	}
	return out;
};

/** エラー(causeを含む)のメッセージに外部キー違反の語があるか。中身は返さない */
const isForeignKeyViolation = (error: unknown): boolean => {
	if (errorCodeOf(error) !== "D1_CONSTRAINT") {
		return false;
	}
	let node: unknown = error;
	for (let i = 0; i < 4 && node instanceof Error; i += 1) {
		if (/FOREIGN KEY/i.test(node.message)) {
			return true;
		}
		node = node.cause;
	}
	return false;
};

/** IN句の分割幅(100バインドの上限対策) */
const EXISTENCE_CHUNK_SIZE = 90;

/**
 * 行をupsertし、実際の行idとjev_resultを返す。評価がLayer 1で読んだ後に相手の意思が
 * 削除されると、その相手を含む行が外部キー違反になりバッチ全体が失敗する(#43)。
 * その場合だけ、D1に行の無い意思を含む行を除いて1回だけやり直す(除いた行は戻り値に入らない)。
 * やり直しも失敗したら例外を外へ出す。UNIQUE衝突はON CONFLICTで処理済みのため対象外
 */
export const upsertCandidateRows = async (
	db: DrizzleD1Database,
	rows: (typeof matchCandidates.$inferInsert)[],
	now: Date,
): Promise<Map<string, { id: string; jevResult: JevAxes | null }>> => {
	try {
		return await upsertAndReadRows(db, rows, now);
	} catch (error) {
		if (!isForeignKeyViolation(error)) {
			throw error;
		}
		const ids = [...new Set(rows.flatMap((r) => [r.intentAId, r.intentBId]))];
		const existing = new Set<string>();
		for (let i = 0; i < ids.length; i += EXISTENCE_CHUNK_SIZE) {
			const found = await db
				.select({ id: intents.id })
				.from(intents)
				.where(inArray(intents.id, ids.slice(i, i + EXISTENCE_CHUNK_SIZE)));
			for (const f of found) {
				existing.add(f.id);
			}
		}
		const kept = rows.filter(
			(r) => existing.has(r.intentAId) && existing.has(r.intentBId),
		);
		return await upsertAndReadRows(db, kept, now);
	}
};
