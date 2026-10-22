/**
 * 評価実行(第2段・docs/06 §2〜§3・§7)。
 * evaluateIntentはembedding_completedの消費(consumer.ts)とCron(Task 12)の
 * 両方から呼ばれる共通の入口。Layer 2 Candidate Retrieval(Vectorize)→
 * Layer 1 Hard Filter(コード+D1)→ Layer 3 Cheap Judge(合成スコア)→
 * match_candidatesの保存 → Layer 4 Jev → Layer 5 Scoring → 提案化 →
 * last_evaluated_atの更新までを行う(F4a設計 §1・§3.1)。グループLATCHの集合も
 * 同じ評価の中で組み立て、1対1とJevの枠(K_j=8)を分け合う(F4b設計 §1・§2.4)。
 * グループ部分の失敗は1対1の評価と提案を止めない(F4b設計 §5)。
 * イベントの存在を知らない設計とし(docs/06 §7の計測はイベント単位で行う)、
 * 層通過の計測結果を戻り値で返す。Analytics Engineへの送信とログはここで
 * 共通に行い、起点イベントpayloadへの反映は呼び出し側(consumer.ts)が行う
 */
import { LATCH, PIPELINE } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import type { JevHeldReason } from "../jev/runner";
import { blockedForProposal, proposeSet } from "../latches/propose";
import type { JevFn } from "../llm/types";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import { upsertCandidateRows } from "./candidates";
import { cheapJudgeScore, geoDistanceM } from "./cheap";
import { errorCodeOf } from "./errors";
import {
	type AllocationPlan,
	intentPairKey,
	planJevAllocation,
	sizeFits,
} from "./group";
import {
	finishGroups,
	type GroupOutcome,
	type GroupPrep,
	prepareGroups,
} from "./group-eval";
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
	/** 提案化して提示した件数(proposeSetが"proposed") */
	proposed: number;
	/** 提案化したが通知上限で保留した件数(proposeSetが"held") */
	held: number;
	/** 人数条件(n=2が双方の区間内でない)により1対1のLayer 4へ渡さなかった件数(F4b設計 §2.1) */
	l4SkippedParticipants: number;
	/** グループのPoolの件数(Poolを作らない・グループ部分の失敗は0) */
	groupPool: number;
	/** 有効な集合の数(F4b設計 §2.3) */
	groupSets: number;
	/** グループ用にJevへ渡した件数(1対1の対象と重なるペアは1対1側で数える) */
	groupJevCalls: number;
	/** 判定しきれず保留した集合の数(Jev配分の保留+判定欠け・F4b設計 §2.4・§5) */
	groupHeldSets: number;
	/** aggregateが閾値を超えた集合の数 */
	groupOverThreshold: number;
	/** 提示した集合の数(0または1・F4b設計 §2.5) */
	groupProposed: number;
	/** 通知上限で保留した集合の数(0または1) */
	groupHeldProposals: number;
	/** グループ部分(準備・仕上げ)で例外が起きたら1(F4b設計 §5・1対1の結果は返す) */
	groupFailed: 0 | 1;
	/** Layer 2 Candidate Retrieval(store.query)の所要時間(ミリ秒・負荷試験の集計用) */
	retrievalMs: number;
}

/** evaluateIntentの差し替え口(試験用)。jevはLayer 4へそのまま渡す */
export interface EvaluateOptions {
	jev?: { primary: JevFn; fallback: JevFn };
	/** 第1段が計算した自分のベクトル。あればgetByIdsで読まずLayer 2へ使う */
	vector?: number[];
	/** trueなら30分再評価抑制の確認だけを飛ばす(送り直しの評価用) */
	ignoreSuppression?: boolean;
}

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
		options?.ignoreSuppression !== true &&
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
	let ownValues = options?.vector;
	if (ownValues === undefined) {
		const [vector] = await store.getByIds([intentId]);
		if (vector === null) {
			return null;
		}
		ownValues = vector.values;
	}
	const startedAtMs = now.getTime();
	// Layer 2 Candidate Retrieval(docs/06 §3): filter={form, status:"active"}付きで
	// topK=100。取り出し後の判定はLayer 1が担う
	// 所要時間は処理時間の計測でありClockを使う時刻依存のロジックではないため
	// performance.now()で測る
	const retrievalStart = performance.now();
	const hits = await store.query(ownValues, {
		topK: PIPELINE.TOP_K_RETRIEVAL,
		filter: { form, status: "active" },
	});
	const retrievalMs = Math.round(performance.now() - retrievalStart);
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
	// 実経路では到達しにくい)。点数はl1Top全件で出し、グループのPool選定にも使う
	// (F4b設計 §2.2)
	const l1Scored = l1Top
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
		.sort(byScoreDescThenIdAsc);
	const l3Scored = l1Scored.slice(0, PIPELINE.LAYER3_OUTPUT_MAX);

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
	// upsertと実際の行id(衝突時は既存行のid)の読み直しはcandidates.tsが担う
	const savedRows = await upsertCandidateRows(db, rows, now);
	// 提案履歴により今は提案できない相手(既存行あり かつ 再提案不可・抑制期間中)は
	// Layer 4へ渡さない(Jevの枠と予算を使わない・docs/06 §5)。Layer 1の恒久排除とは
	// 別に数える。proposeSet側の判定も残す(並行時の正)
	const historyBlocked = await blockedForProposal(
		db,
		intent,
		l3Scored.map((item) => item.candidate),
		now,
	);
	// 1対1の対象(F4b設計 §2.1・§2.4の1): 履歴で除外されず、人数2が双方の区間に
	// 入る候補をLayer 3降順のまま。人数条件の不合格はJevの枠を使わない
	const oneOnOne = new Map<string, { rowId: string; other: IntentRow }>();
	let l4SkippedHistory = 0;
	let l4SkippedParticipants = 0;
	for (const item of l3Scored) {
		if (historyBlocked.has(item.candidate.id)) {
			l4SkippedHistory += 1;
			continue;
		}
		if (!sizeFits([intent, item.candidate], 2)) {
			l4SkippedParticipants += 1;
			continue;
		}
		const key = intentPairKey(intent.id, item.candidate.id);
		const rowId = savedRows.get(key)?.id;
		if (rowId === undefined) {
			// 到達しない(直前のupsertで必ず存在する)・防御
			continue;
		}
		oneOnOne.set(key, { rowId, other: item.candidate });
	}
	// jev_resultが既にあるペア(1対1の行+グループの行)
	const known = new Set<string>();
	for (const [key, row] of savedRows) {
		if (row.jevResult !== null) {
			known.add(key);
		}
	}

	// グループの準備とJev配分(F4b設計 §2.2〜§2.4)。失敗しても1対1だけで続ける(§5)
	let prep: GroupPrep | null = null;
	let groupFailed: 0 | 1 = 0;
	try {
		prep = await prepareGroups(
			env,
			db,
			intent,
			l1Scored.map((item) => ({
				intent: item.candidate,
				cheapScore: item.score,
				similarity: item.retrievalScore,
			})),
			now,
		);
		for (const [key, row] of prep?.rows ?? []) {
			if (row.jevResult !== null) {
				known.add(key);
			}
		}
	} catch (error) {
		// 準備の途中で失敗した集合は扱わない(prepはnullのまま・1対1だけで配分する)
		groupFailed = 1;
		logger.warn("pipeline.group.failed", {
			intent_id: intentId,
			error_code: errorCodeOf(error),
		});
	}
	const plan: AllocationPlan = planJevAllocation({
		oneOnOne: [...oneOnOne.keys()],
		sets: prep?.sets ?? [],
		known,
	});

	// Layer 4 Jev(F4a設計 §2.3・F4b設計 §2.4の4): 1対1(Layer 3降順)を先・グループの
	// 新規ペアを後にした1つの列で1回だけ呼ぶ。予算は起点側のみ計上する
	const l4Candidates: L4Candidate[] = [];
	for (const key of plan.oneOnOneKeys) {
		const target = oneOnOne.get(key);
		if (target !== undefined) {
			l4Candidates.push({
				rowId: target.rowId,
				origin: intent,
				other: target.other,
			});
		}
	}
	for (const key of plan.groupKeys) {
		const row = prep?.rows.get(key);
		if (row !== undefined) {
			l4Candidates.push({ rowId: row.id, origin: row.a, other: row.b });
		}
	}
	const l4 = await runLayer4(
		env,
		clock,
		{ intentId: intent.id, userId: intent.userId },
		l4Candidates,
		options?.jev,
	);
	// 枠に収まらずJevへ渡さなかった1対1は「1イベントの呼び出し枠」の保留として数える
	const jevHeld = {
		...l4.run.held,
		cap: l4.run.held.cap + plan.oneOnOneCapped,
	};

	// Layer 5 Scoring(docs/06 §6・F4a設計 §3.1): Jev結果のある全行のLを保存する
	// (閾値未満も保存・他人どうしの行を含む・Hは候補化時点でLayer 1通過のため1)
	for (const c of l4Candidates) {
		const axes = l4.axesByRow.get(c.rowId);
		if (axes === undefined) {
			continue;
		}
		await db
			.update(matchCandidates)
			.set({ latchScore: latchScore(axes, 1), updatedAt: now })
			.where(eq(matchCandidates.id, c.rowId));
	}
	// 1対1の提案対象は起点を含む1対1の対象の行だけ
	const l5Items: L5Item[] = [];
	const otherByRow = new Map<string, IntentRow>();
	for (const key of plan.oneOnOneKeys) {
		const target = oneOnOne.get(key);
		const axes =
			target === undefined ? undefined : l4.axesByRow.get(target.rowId);
		if (target === undefined || axes === undefined) {
			continue;
		}
		l5Items.push({
			rowId: target.rowId,
			pair: pairKey(intent.userId, target.other.userId),
			score: latchScore(axes, 1),
		});
		otherByRow.set(target.rowId, target.other);
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
			// membersはid昇順(match_candidatesの正規化順と同じ)
			const members = intent.id < other.id ? [intent, other] : [other, intent];
			const outcome = await proposeSet(
				db,
				{
					members,
					score: pick.score,
					source: { kind: "pair", rowId: pick.rowId },
				},
				now,
			);
			if (outcome === "proposed") {
				proposed += 1;
			} else if (outcome === "held") {
				held += 1;
			}
		}
	}

	// 集合の点数・保存・提案(F4b設計 §2.5)。1対1の提案の後に1集合だけ。失敗は隔離する(§5)
	let group: GroupOutcome | null = null;
	if (prep !== null) {
		try {
			group = await finishGroups(db, prep, plan.plannedSets, l4.axesByRow, now);
		} catch (error) {
			groupFailed = 1;
			logger.warn("pipeline.group.failed", {
				intent_id: intentId,
				error_code: errorCodeOf(error),
			});
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
		jevHeld,
		jevLatencyMs: l4.run.latencyMs,
		l5OverThreshold,
		proposed,
		held,
		l4SkippedParticipants,
		groupPool: prep?.poolSize ?? 0,
		groupSets: prep?.sets.length ?? 0,
		groupJevCalls: plan.groupKeys.length,
		groupHeldSets: plan.heldSets + (group?.heldSets ?? 0),
		groupOverThreshold: group?.overThreshold ?? 0,
		groupProposed: group?.proposed ?? 0,
		groupHeldProposals: group?.held ?? 0,
		groupFailed,
		retrievalMs,
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
