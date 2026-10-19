/**
 * 評価実行(第2段・docs/06 §2〜§3・§7)。
 * evaluateIntentはembedding_completedの消費(consumer.ts)とCron(Task 12)の
 * 両方から呼ばれる共通の入口。Layer 2 Candidate Retrieval(Vectorize)→
 * Layer 1 Hard Filter(コード+D1)→ Layer 3 Cheap Judge(合成スコア)→
 * match_candidatesの保存 → last_evaluated_atの更新までを行う。
 * イベントの存在を知らない設計とし(docs/06 §7の計測はイベント単位で行う)、
 * 層通過の計測結果を戻り値で返す。Analytics Engineへの送信とログはここで
 * 共通に行い、起点イベントpayloadへの反映は呼び出し側(consumer.ts)が行う
 */
import { PIPELINE } from "@latch/shared";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import { cheapJudgeScore } from "./cheap";
import { fetchL1Data, layer1Judge, pairKey } from "./layer1";
import { writeStage2Metrics } from "./metrics";

const logger = createLogger();

/** intents行の型(db/schemaの$inferSelect) */
type IntentRow = typeof intents.$inferSelect;

/** evaluateIntentの戻り値(第2段の計測結果・docs/06 §7の層通過件数) */
export interface Stage2Result {
	/** Vectorize取得件数(topKで頭打ち・自idの除外前) */
	retrievalCount: number;
	/** Layer 1判定の通過後、上位K_vに絞り込んでLayer 3へ渡した件数 */
	l1Pass: number;
	/** Layer 1の除外理由別内訳(docs/06 §7) */
	exclusions: Record<string, number>;
	/** Layer 3通過(上位K_c)でmatch_candidatesへ保存した件数 */
	l3Pass: number;
}

/** 地球半径(メートル)。ハバーシン距離の計算に使う(layer1.tsと同一の式) */
const EARTH_RADIUS_M = 6_371_000;

/** 度→ラジアン */
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 中心間のハバーシン距離(メートル)。Layer 3の地理近接の入力用。
 * 式はlayer1.tsのhaversineMと同一(半径の和との比較判定はLayer 1が担うため
 * こちらでは行わない)
 */
const haversineM = (
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number => {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/** geo3点(lat/lng/radius)が揃っている場合のみ中心を返す(片方のみ・未添付はnull) */
const geoOf = (intent: IntentRow): { lat: number; lng: number } | null =>
	intent.geoCenterLat !== null &&
	intent.geoCenterLng !== null &&
	intent.geoRadiusM !== null
		? { lat: intent.geoCenterLat, lng: intent.geoCenterLng }
		: null;

/**
 * 両Intentの中心間距離(m)。片方・双方の地理未添付はnull
 * (Layer 3のgeoProximityはnullを中立値として扱う・docs/06 §3)
 */
const geoDistanceM = (a: IntentRow, b: IntentRow): number | null => {
	const originGeo = geoOf(a);
	const candidateGeo = geoOf(b);
	return originGeo === null || candidateGeo === null
		? null
		: haversineM(originGeo, candidateGeo);
};

/** スコア降順・同点はULID昇順(docs/06 §3の同点の規律)の比較関数 */
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

/** 候補upsertの分割幅(13列×7行=91バインド・D1の上限100対策) */
const UPSERT_CHUNK_SIZE = 7;

/**
 * 評価実行(第2段・docs/06 §2〜§3)。対象外(active以外・行不在)・30分抑制中
 * (docs/06 §4)・ベクトル不在(埋め込み未完了=バックフィル対象外パス)のときは
 * 何も書かずnullを返す。それ以外は検索→Layer 1→Layer 3→候補保存→
 * last_evaluated_at更新→計測までを行い計測結果を返す
 */
export const evaluateIntent = async (
	env: Env,
	intentId: string,
	clock: Clock,
): Promise<Stage2Result | null> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	const [intent] = await db
		.select()
		.from(intents)
		.where(eq(intents.id, intentId))
		.limit(1);
	// 評価対象はactiveのみ(存在しない・draft/paused/expiredは対象外・docs/06 §2)
	if (intent === undefined || intent.status !== "active") {
		return null;
	}
	// 30分再評価抑制(docs/06 §4): 抑制中は一切書かずに抜ける
	if (
		intent.lastEvaluatedAt !== null &&
		now.getTime() - intent.lastEvaluatedAt.getTime() <
			PIPELINE.REEVALUATION_SUPPRESSION_MS
	) {
		return null;
	}
	// active化済みIntentのformは非null(draft→active化でform検証済み・docs/05 §2.2)。
	// 検索filterや候補行に渡す値として取り出す(到達しない防御)
	const form = intent.form;
	if (form === null) {
		return null;
	}
	const store = createVectorStore(env);
	// 起点Intent自身のベクトル(無ければ埋め込み未完了=バックフィル対象外パス・06 §2)
	const [vector] = await store.getByIds([intentId]);
	if (vector === null) {
		return null;
	}
	const startedAtMs = now.getTime();
	// Layer 2 Candidate Retrieval(docs/06 §3): filter={form, status:"active"}付きで
	// topK=100。取り出し後の判定はLayer 1が担う
	const hits = await store.query(vector.values, {
		topK: PIPELINE.TOP_K_RETRIEVAL,
		filter: { form, status: "active" },
	});
	const retrievalCount = hits.length;
	// 自己idの除外は呼び出し側が担う(vectorstore/types.tsの契約)
	const retrieved = hits.filter((hit) => hit.id !== intentId);

	// Layer 1 Hard Filter(docs/06 §3・コード+D1): 除外理由を集計する
	const l1 = await fetchL1Data(
		db,
		intent.userId,
		retrieved.map((hit) => hit.id),
	);
	const exclusions: Record<string, number> = {};
	const passed: { id: string; score: number; candidate: IntentRow }[] = [];
	for (const hit of retrieved) {
		const candidate = l1.intents[hit.id] ?? null;
		const judgement = layer1Judge(
			intent,
			candidate,
			l1.birthDates,
			candidate === null
				? false
				: l1.blockedPairs.has(pairKey(intent.userId, candidate.userId)),
			candidate === null
				? false
				: l1.historyPairs.has(pairKey(intent.userId, candidate.userId)),
			now,
		);
		if (!judgement.pass) {
			// 不合格は理由別に集計する(docs/06 §7のLayer 1除外理由別内訳)
			const { reason } = judgement;
			if (reason !== undefined) {
				exclusions[reason] = (exclusions[reason] ?? 0) + 1;
			}
			continue;
		}
		if (candidate === null) {
			// 到達しない(passはfail-closeでD1行不在を除外するため)・防御
			continue;
		}
		passed.push({ id: hit.id, score: hit.score, candidate });
	}

	// Layer 1通過後、類似度(Vectorizeスコア)上位K_v=50を次層へ渡す
	// (同点はULID昇順・docs/06 §3)
	const l1Top = passed
		.sort(byScoreDescThenIdAsc)
		.slice(0, PIPELINE.LAYER1_OUTPUT_MAX);

	// Layer 3 Cheap Judge(docs/06 §3・課金ゼロ): 合成スコアで上位K_c=20を選ぶ。
	// topicは確定後の値を渡す。activeではtopic非nullが原則だが、防御としてnullは
	// 空文字へ倒す(null同士は満点になる既知の挙動・Layer 2のfilter=activeの
	// 実経路では到達しにくい)
	const l3Scored = l1Top
		.map((item) => ({
			id: item.id,
			score: cheapJudgeScore({
				similarity: item.score,
				topicA: intent.topic ?? "",
				topicB: item.candidate.topic ?? "",
				participantsA: {
					min: intent.participantsMin,
					max: intent.participantsMax,
				},
				participantsB: {
					min: item.candidate.participantsMin,
					max: item.candidate.participantsMax,
				},
				geoDistanceM: geoDistanceM(intent, item.candidate),
			}),
			retrievalScore: item.score,
			candidate: item.candidate,
		}))
		.sort(byScoreDescThenIdAsc)
		.slice(0, PIPELINE.LAYER3_OUTPUT_MAX);

	// match_candidatesへupsert(docs/05 §2.2): a<b正規化。UNIQUE(a,b,va,vb)の
	// 衝突はON CONFLICT DO UPDATEで再評価の結果を上書きする(行は増やさない)
	const rows = l3Scored.map((item) => {
		const originFirst = intent.id < item.candidate.id;
		return {
			id: newUlid(),
			intentAId: originFirst ? intent.id : item.candidate.id,
			intentBId: originFirst ? item.candidate.id : intent.id,
			intentAVersion: originFirst ? intent.version : item.candidate.version,
			intentBVersion: originFirst ? item.candidate.version : intent.version,
			form,
			retrievalScore: item.retrievalScore,
			cheapJudgeScore: item.score,
			status: "candidate",
			createdAt: now,
			updatedAt: now,
		} satisfies typeof matchCandidates.$inferInsert;
	});
	for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
		await db
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
					status: "candidate",
					updatedAt: now,
				},
			});
	}

	// 30分再評価抑制の起点を更新する(docs/05 §2.6)
	await db
		.update(intents)
		.set({ lastEvaluatedAt: now })
		.where(eq(intents.id, intentId));

	const latencyMs = clock.now().getTime() - startedAtMs;
	const result: Stage2Result = {
		retrievalCount,
		l1Pass: l1Top.length,
		exclusions,
		l3Pass: rows.length,
	};
	// 計測(Analytics Engine+ログ・docs/06 §7)。Cron呼び出しはこの計測のみを受け、
	// イベントpayloadへの反映は呼び出し側(consumer.ts)が行う
	writeStage2Metrics(env, { ...result, latencyMs });
	logger.info("pipeline.stage2.completed", {
		intent_id: intentId,
		count: result.l3Pass,
		latency: latencyMs,
	});
	return result;
};
