/**
 * 評価実行(第2段・docs/06 §2〜§3・§7)。
 * evaluateIntentはembedding_completedの消費(consumer.ts)とCron(Task 12)の
 * 両方から呼ばれる共通の入口。Layer 2 Candidate Retrieval(Vectorize)→
 * Layer 1 Hard Filter(コード+D1)→ Layer 3 Cheap Judge(合成スコア)→
 * match_candidatesの保存 → Layer 4 Jev → Layer 5 Scoring → 提案化 →
 * last_evaluated_atの更新までを行う(F4a設計 §1・§3.1)。
 * イベントの存在を知らない設計とし(docs/06 §7の計測はイベント単位で行う)、
 * 層通過の計測結果を戻り値で返す。Analytics Engineへの送信とログはここで
 * 共通に行い、起点イベントpayloadへの反映は呼び出し側(consumer.ts)が行う
 */
import { LATCH, PIPELINE } from "@latch/shared";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import type { JevHeldReason } from "../jev/runner";
import { blockedForProposal, proposePair } from "../latches/propose";
import type { JevFn } from "../llm/types";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import { cheapJudgeScore } from "./cheap";
import { fetchL1Data, layer1Judge, pairKey } from "./layer1";
import { type L4Candidate, runLayer4 } from "./layer4";
import { type L5Item, latchScore, pickProposals, recheckHard } from "./layer5";
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
	/** 提案履歴(既存行・抑制期間)により提案できずLayer 4へ渡さなかった件数(docs/06 §5) */
	l4SkippedHistory: number;
	/** Jevの実呼び出し数(フォールバック含む・K_j以下・#14) */
	jevCalls: number;
	/** jev_resultを再利用してJevを呼ばなかった件数 */
	jevReused: number;
	/** Jevの保留の理由別内訳(予算・breaker・失敗・呼び出し枠) */
	jevHeld: Record<JevHeldReason, number>;
	/** Jev実行の処理時間(ミリ秒) */
	jevLatencyMs: number;
	/** Layer 5でLATCH Scoreが閾値を超えた件数(ペア単位の絞り込み前) */
	l5OverThreshold: number;
	/** 提案化して提示した件数(proposePairが"proposed") */
	proposed: number;
	/** 提案化したが通知上限で保留した件数(proposePairが"held") */
	held: number;
}

/** evaluateIntentの差し替え口(試験用)。jevはLayer 4へそのまま渡す */
export interface EvaluateOptions {
	jev?: { primary: JevFn; fallback: JevFn };
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

/** match_candidatesのUNIQUEキー(intent_a_id, intent_b_id, intent_a_version, intent_b_version)の文字列化 */
const candidateKey = (r: {
	intentAId: string;
	intentBId: string;
	intentAVersion: number;
	intentBVersion: number;
}): string =>
	`${r.intentAId}:${r.intentBId}:${r.intentAVersion}:${r.intentBVersion}`;

/**
 * 評価実行(第2段・docs/06 §2〜§3)。対象外(active以外・行不在)・30分抑制中
 * (docs/06 §4)・ベクトル不在(埋め込み未完了=バックフィル対象外パス)のときは
 * 何も書かずnullを返す。それ以外は検索→Layer 1→Layer 3→候補保存→
 * Layer 4→Layer 5→提案化→last_evaluated_at更新→計測までを行い計測結果を返す
 */
export const evaluateIntent = async (
	env: Env,
	intentId: string,
	clock: Clock,
	options?: EvaluateOptions,
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
	// 衝突はON CONFLICT DO UPDATEで再評価のスコアを上書きする(行は増やさない・statusは保持)
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
					// statusは上書きしない(新規INSERTの行だけがcandidateになり、
					// 提案済み・クローズ済みの既存行は状態を保つ)
					updatedAt: now,
				},
			});
	}

	// upsertは衝突時に既存行のidを保持するため、UNIQUEキーで読み直して実際の行idを得る
	const rowIdByKey = new Map<string, string>();
	const otherIds = l3Scored.map((item) => item.candidate.id);
	if (otherIds.length > 0) {
		const saved = await db
			.select({
				id: matchCandidates.id,
				intentAId: matchCandidates.intentAId,
				intentBId: matchCandidates.intentBId,
				intentAVersion: matchCandidates.intentAVersion,
				intentBVersion: matchCandidates.intentBVersion,
			})
			.from(matchCandidates)
			.where(
				or(
					and(
						eq(matchCandidates.intentAId, intent.id),
						eq(matchCandidates.intentAVersion, intent.version),
						inArray(matchCandidates.intentBId, otherIds),
					),
					and(
						eq(matchCandidates.intentBId, intent.id),
						eq(matchCandidates.intentBVersion, intent.version),
						inArray(matchCandidates.intentAId, otherIds),
					),
				) as SQL,
			);
		for (const r of saved) {
			rowIdByKey.set(candidateKey(r), r.id);
		}
	}
	// 提案履歴により今は提案できない相手(既存行あり かつ 再提案不可・抑制期間中)は
	// Layer 4へ渡さない(Jevの枠と予算を使わない・docs/06 §5)。Layer 1の恒久排除とは
	// 別に数える。proposePair側の判定も残す(並行時の正)
	const historyBlocked = await blockedForProposal(
		db,
		intent,
		l3Scored.map((item) => item.candidate),
		now,
	);
	// Layer 4 Jev(F4a設計 §2.3): Layer 3降順のまま、起点=evaluateIntentの対象・
	// 相手=候補Intentで渡す(予算計上が起点基準のため行の向きに依らない)
	const l4Candidates: L4Candidate[] = [];
	let l4SkippedHistory = 0;
	for (const [index, item] of l3Scored.entries()) {
		if (historyBlocked.has(item.candidate.id)) {
			l4SkippedHistory += 1;
			continue;
		}
		const row = rows[index];
		const rowId =
			row === undefined ? undefined : rowIdByKey.get(candidateKey(row));
		if (rowId === undefined) {
			// 到達しない(直前のupsertで必ず存在する)・防御
			continue;
		}
		l4Candidates.push({
			rowId,
			origin: intent,
			other: item.candidate,
			cheapScore: item.score,
		});
	}
	const l4 = await runLayer4(env, clock, l4Candidates, options?.jev);

	// Layer 5 Scoring(docs/06 §6・F4a設計 §3.1): Jev結果のある全行のLを保存する
	// (閾値未満も保存・Hは候補化時点でLayer 1通過のため1)
	const l5Items: L5Item[] = [];
	const otherByRow = new Map<string, IntentRow>();
	for (const c of l4Candidates) {
		const axes = l4.axesByRow.get(c.rowId);
		if (axes === undefined) {
			continue;
		}
		const score = latchScore(axes, 1);
		await db
			.update(matchCandidates)
			.set({ latchScore: score, updatedAt: now })
			.where(eq(matchCandidates.id, c.rowId));
		l5Items.push({
			rowId: c.rowId,
			pair: pairKey(intent.userId, c.other.userId),
			score,
		});
		otherByRow.set(c.rowId, c.other);
	}
	const l5OverThreshold = l5Items.filter(
		(item) => item.score > LATCH.THRESHOLD,
	).length;
	const picks = pickProposals(l5Items);

	// 提案の直前にHをD1の現行値で再検証し、合格した相手だけを
	// L降順に提案化する(docs/06 §6・F4a設計 §3.1〜§3.2)
	let proposed = 0;
	let held = 0;
	if (picks.length > 0) {
		const passedIds = await recheckHard(
			db,
			intent.id,
			picks.flatMap((pick) => {
				const other = otherByRow.get(pick.rowId);
				return other === undefined ? [] : [other.id];
			}),
			now,
		);
		for (const pick of picks) {
			const other = otherByRow.get(pick.rowId);
			if (other === undefined || !passedIds.has(other.id)) {
				continue;
			}
			// a/bはmatch_candidatesの正規化順(a.id < b.id)
			const [a, b] = intent.id < other.id ? [intent, other] : [other, intent];
			const outcome = await proposePair(
				db,
				{ rowId: pick.rowId, a, b, score: pick.score },
				now,
			);
			if (outcome === "proposed") {
				proposed += 1;
			} else if (outcome === "held") {
				held += 1;
			}
		}
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
		l4SkippedHistory,
		jevCalls: l4.run.calls,
		jevReused: l4.reused,
		jevHeld: l4.run.held,
		jevLatencyMs: l4.run.latencyMs,
		l5OverThreshold,
		proposed,
		held,
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
