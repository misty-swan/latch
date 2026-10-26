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
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { type Clock, systemClock } from "../clock/clock";
import { intents, type JevHeldKind, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import { isBreakerOpen } from "../jev/breaker";
import type { JevHeldReason } from "../jev/runner";
import { blockedForProposal, proposeSet } from "../latches/propose";
import type { JevFn } from "../llm/types";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import type { VectorStore } from "../vectorstore/types";
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
import { type EvaluateOrigin, writeStage2Metrics } from "./metrics";
import { createMetricsBudget, type MetricsBudget } from "./metrics-budget";
import {
	loadRecentVectorRefs,
	loadRecentVectorValues,
	mergeSupplement,
	refsMissingFromHits,
} from "./recent-vectors";

const logger = createLogger();

/** intents行の型(db/schemaの$inferSelect) */
type IntentRow = typeof intents.$inferSelect;

/** evaluateIntentの戻り値(第2段の計測結果・docs/06 §7の層通過件数) */
export interface Stage2Result {
	/** Vectorize取得件数(topKで頭打ち・自idの除外前・控えの補いを含まない) */
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
	/** 直近のベクトルの控えから補い、topKで切った後に残った件数(#47・設計 2026-10-25 §1.5) */
	supplementCount: number;
}

/** 第2段の計測結果を起点イベントのpayloadへ載せる形にする(docs/06 §7・順序は試験で固定) */
export const stage2Payload = (
	result: Stage2Result,
): Record<string, unknown> => ({
	retrieval_count: result.retrievalCount,
	l1_pass: result.l1Pass,
	l1_exclusions: result.exclusions,
	l3_pass: result.l3Pass,
	l4_skipped_history: result.l4SkippedHistory,
	jev_calls: result.jevCalls,
	jev_reused: result.jevReused,
	jev_held: result.jevHeld,
	jev_latency: result.jevLatencyMs,
	l5_over_threshold: result.l5OverThreshold,
	proposed: result.proposed,
	held_proposals: result.held,
	l4_skipped_participants: result.l4SkippedParticipants,
	group_pool: result.groupPool,
	group_sets: result.groupSets,
	group_jev_calls: result.groupJevCalls,
	group_held_sets: result.groupHeldSets,
	group_over_threshold: result.groupOverThreshold,
	group_proposed: result.groupProposed,
	group_held_proposals: result.groupHeldProposals,
	group_failed: result.groupFailed,
	retrieval_ms: result.retrievalMs,
	supplement_count: result.supplementCount,
});

/** evaluateIntentの差し替え口(試験用)。jevはLayer 4へそのまま渡す */
export interface EvaluateOptions {
	jev?: { primary: JevFn; fallback: JevFn };
	/** 第1段が計算した自分のベクトル。あればgetByIdsで読まずLayer 2へ使う */
	vector?: number[];
	/** trueなら30分再評価抑制の確認だけを飛ばす(送り直しの評価用) */
	ignoreSuppression?: boolean;
	/** 評価の起点(計測の blobs に載せる・既定 cron_other) */
	origin?: EvaluateOrigin;
	/** 1回の実行の計測の書き込みの残り(省略時はこの呼び出しだけの新しい残り・#28) */
	metricsBudget?: MetricsBudget;
}

/**
 * 第2段の段ごとの所要時間(#36・stagingのwrangler tailで内訳を読む用)。
 * 時刻は渡されたClockでなく実時間(systemClock)で測る(Clockは試験で止まっているため)。
 * 項目はintent_id・layer・latencyだけ(許可リストを増やさない)。
 * lap(layer)は「直前のlapの終わり(最初は評価の開始)から今まで」を1行出して区切りを進める。
 * 段の名前と範囲:
 * - prepare: 意思の読み込み・30分抑制の判定・自分のベクトルの取得(getByIds)
 * - retrieval: Layer 2 Candidate Retrieval(store.query)
 * - supplement: 直近のベクトルの控え(recent_vectors)の読み込み(照会と同時に投げた残りの待ち)と
 *   照会の結果への混ぜ込み(#47)
 * - layer1: Layer 1(D1の読み込みfetchL1Data・孤立ベクトルの自己修復・判定・上位K_vの選択)
 * - layer3: Layer 3の点数付けと上位K_cの選択・match_candidatesの行の組み立て(計算のみ)
 * - candidates: match_candidatesへのupsert・提案履歴による除外・1対1の対象の組み立て
 * - group: グループの準備(prepareGroups)+Jev配分の計画+集合の仕上げ(finishGroups)の合計
 * - jev_pre / jev_call / jev_post: runLayer4の内訳(L4Result.timingsMs・layer4.tsに範囲を記す)
 * - jev_breaker / jev_reserve / jev_http / jev_record: jev_callの内訳(全波の合計・jev/runner.ts)
 * - layer5: Lの保存の文の組み立てとL5の対象・提案候補の選択(計算のみ・#36の直しの後)
 * - propose: 提案があるときのLの保存と提案直前の再検証(recheckHard・同時)と1対1のproposeSet
 * - finish: last_evaluated_atの更新(提案が無いときはLの保存と同じバッチ)と計測(writeStage2Metrics)
 */
const createStageTimer = (intentId: string) => {
	const nowMs = () => systemClock.now().getTime();
	let mark = nowMs();
	const emit = (layer: string, latency: number): void => {
		logger.info("pipeline.stage2.timing", {
			intent_id: intentId,
			layer,
			latency,
		});
	};
	return {
		/** 直前の区切りからの経過を返し、区切りを今に進める(行は出さない) */
		take: (): number => {
			const t = nowMs();
			const elapsed = t - mark;
			mark = t;
			return elapsed;
		},
		/** 区切りを進めずに1行出す(合算した値や内側で測った値を出すとき) */
		emit,
		lap(layer: string): number {
			const elapsed = this.take();
			emit(layer, elapsed);
			return elapsed;
		},
	};
};

/** 文の列を1つのバッチ(1往復)で送る。空なら何もしない */
const runBatch = async (
	db: DrizzleD1Database,
	statements: BatchItem<"sqlite">[],
): Promise<void> => {
	const [first, ...rest] = statements;
	if (first === undefined) {
		return;
	}
	await db.batch([first, ...rest]);
};

/**
 * 評価で残ったJevの保留の印の理由(docs/06 §2(k)・LAT-105)。予算 > circuit breaker > 失敗の順に
 * 1つを選び、保留が無ければnull。上限で枠に収まらなかった分(cap)は障害が無くても残るため数えない。
 * 失敗だけが残り、評価の間にbreakerが開いたとき(障害の広がり)はbreakerとして扱い、
 * 失敗の判定し直しの回数(JEV_HELD_FAILED_RETRY_MAX)を使わせない
 */
const jevHeldKindOf = async (
	env: Env,
	held: Record<JevHeldReason, number>,
	now: Date,
): Promise<JevHeldKind | null> => {
	if (held.budget > 0) {
		return "budget";
	}
	if (held.breaker > 0) {
		return "breaker";
	}
	if (held.failed > 0) {
		return (await isBreakerOpen(env.PIPELINE_KV, now)) ? "breaker" : "failed";
	}
	return null;
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

/**
 * 孤立したベクトルを消し、件数だけをログに出す(#20・設計 §5.2)。失敗は評価を止めず
 * warnだけにする(消えなかったものは次の評価のhitで再び見つかる)
 */
const deleteOrphanVectors = async (
	store: VectorStore,
	orphanIds: string[],
): Promise<void> => {
	if (orphanIds.length === 0) {
		return;
	}
	try {
		await store.deleteByIds(orphanIds);
		logger.info("pipeline.orphan.deleted", { count: orphanIds.length });
	} catch (error) {
		logger.warn("pipeline.orphan.failed", {
			error_code: errorCodeOf(error),
			count: orphanIds.length,
		});
	}
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
	const timer = createStageTimer(intentId);
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
	timer.lap("prepare");
	// 直近のベクトルの控えによる補い(#47・設計 2026-10-25 §1.4): 照会(Vectorize)が古い状態を
	// 返して相手を見落とすことがあるため、15分以内に埋め込んだ同じformのactiveの意思を控えから読み、
	// 照会の結果に無いものだけを類似度で混ぜてtopKで切る。以降は合わせた結果を従来どおり使う。
	// 控えはLayer 1で必ず落ちる相手(同じ利用者・時間の重なり15分未満)を除いて読む(LAT-99)。
	// 補った行はD1に意思の行があるため、孤立したベクトルの自己修復の対象にならない。
	// 控えのidと時刻の読み込み(D1)は照会と同時に投げ、直列の待ちを増やさない(#36)。
	// ベクトルは照会の結果に無いidがあるときだけ2回目に読む(通信を数KBに抑える)。
	// 読み込みの失敗は補いなしで続ける(従来の動作に戻るだけ)
	const recentLoadFailed = (error: unknown) => {
		logger.warn("pipeline.recent_vector.failed", {
			intent_id: intentId,
			layer: "load",
			error_code: errorCodeOf(error),
		});
		return [];
	};
	const refsPromise = loadRecentVectorRefs(env.DB, {
		origin: intent,
		now,
		limit: PIPELINE.RECENT_VECTOR_SUPPLEMENT_MAX,
	}).catch(recentLoadFailed);
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
	timer.lap("retrieval");
	// 照会が返した件数(補いを含まない・自idの除外前)
	const retrievalCount = hits.length;
	const missing = refsMissingFromHits(await refsPromise, hits);
	const recent =
		missing.length === 0
			? []
			: await loadRecentVectorValues(env.DB, missing).catch(recentLoadFailed);
	const merged = mergeSupplement(
		hits,
		recent,
		ownValues,
		PIPELINE.TOP_K_RETRIEVAL,
	);
	const supplementCount = merged.supplemented;
	timer.lap("supplement");
	// 自己idの除外は呼び出し側が担う(vectorstore/types.tsの契約)
	const retrieved = merged.hits.filter((hit) => hit.id !== intentId);

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
	timer.lap("layer1");

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
	timer.lap("layer3");

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
	// upsertと実際の行id(衝突時は既存行のid)の読み直しはcandidates.tsが担う。
	// 提案履歴により今は提案できない相手(既存行あり かつ 再提案不可・抑制期間中)は
	// Layer 4へ渡さない(Jevの枠と予算を使わない・docs/06 §5)。Layer 1の恒久排除とは
	// 別に数える。proposeSet側の判定も残す(並行時の正)。
	// 履歴の読み込みは候補行と無関係のため、upsertと同時に投げる(#36)
	const [savedRows, historyBlocked] = await Promise.all([
		upsertCandidateRows(db, rows, now),
		blockedForProposal(
			db,
			intent,
			l3Scored.map((item) => item.candidate),
			now,
		),
	]);
	// 孤立したベクトルの自己修復(#20・設計 §5.2): Layer 1が読んだ結果にD1の行が無いhitは、
	// 削除の後に残ったベクトル(意思の行は必ずベクトルより先に作られる)。
	// 候補行の保存の後に消す(#43): 評価の途中で相手が削除された競り合いでは、先にベクトルを
	// 消すと保存側の外部キー違反の原因調査と混ざるため、保存が終わってから後始末する。追加の照会はせず、
	// 1回の評価でORPHAN_DELETE_MAX件まで消す。行のあるhit(反映待ち・paused等)は消さない
	await deleteOrphanVectors(
		store,
		retrieved
			.map((hit) => hit.id)
			.filter((id) => l1.intents[id] === undefined)
			.slice(0, PIPELINE.ORPHAN_DELETE_MAX),
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

	timer.lap("candidates");

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
	// グループの準備とJev配分の計画までの時間はgroupに数える(仕上げの分と最後に合算して出す)
	let groupMs = timer.take();
	const l4 = await runLayer4(
		env,
		clock,
		{ intentId: intent.id, userId: intent.userId },
		l4Candidates,
		options?.jev,
	);
	// マークを進めるだけ。Jevの時間はtimingsMsから出す
	timer.take();
	timer.emit("jev_pre", l4.timingsMs.pre);
	timer.emit("jev_call", l4.timingsMs.call);
	// jev_callの内訳(jev_http: 外部呼び出しの並列区間。外部送信の集計の書き込みを含み分けられない)
	for (const [label, ms] of Object.entries(l4.callBreakdownMs)) {
		timer.emit(label, ms);
	}
	timer.emit("jev_post", l4.timingsMs.post);
	// 枠に収まらずJevへ渡さなかった1対1は「1イベントの呼び出し枠」の保留として数える
	const jevHeld = {
		...l4.run.held,
		cap: l4.run.held.cap + plan.oneOnOneCapped,
	};

	// Layer 5 Scoring(docs/06 §6・F4a設計 §3.1): Jev結果のある全行のLを保存する
	// (閾値未満も保存・他人どうしの行を含む・Hは候補化時点でLayer 1通過のため1)。
	// 書き込みは文を組むだけにして、提案があるときは提案直前の再検証と同時に、提案が無い
	// ときはlast_evaluated_atの更新と同じバッチで送る(D1の直列の待ちを減らす・#36)
	const scoreWrites: BatchItem<"sqlite">[] = [];
	for (const c of l4Candidates) {
		const axes = l4.axesByRow.get(c.rowId);
		if (axes === undefined) {
			continue;
		}
		scoreWrites.push(
			db
				.update(matchCandidates)
				.set({ latchScore: latchScore(axes, 1), updatedAt: now })
				.where(eq(matchCandidates.id, c.rowId)),
		);
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
	timer.lap("layer5");

	// 提案の直前にHをD1の現行値で再検証し、合格した相手だけを
	// L降順に提案化する(docs/06 §6・F4a設計 §3.1〜§3.2)。提案の通知の行の作成時刻は
	// 評価の開始時刻(now)でなく提案を作る直前の時刻にする(判定後の起点・LAT-98)
	let proposed = 0;
	let held = 0;
	// 提案が無いときは、Lの保存をlast_evaluated_atの更新と同じバッチへ回す(間に挟まるのは
	// 例外を外へ出さないグループの仕上げだけで、Lの値を読む処理は無い)
	let deferredScoreWrites: BatchItem<"sqlite">[] = scoreWrites;
	if (picks.length > 0) {
		deferredScoreWrites = [];
		// Lの保存(書き込み)と再検証(読み込み)は互いに依存しないため同時に投げ、
		// 両方の終わりを待ってから提案化へ進む(Lの保存は従来どおり提案化より前に終わる)。
		// 失敗したときは従来の順(保存→再検証)で先に失敗した方の例外を投げる
		const [writing, rechecking] = await Promise.allSettled([
			runBatch(db, scoreWrites),
			recheckHard(
				db,
				intent.id,
				picks.flatMap((pick) => {
					const other = otherByRow.get(pick.rowId);
					return other === undefined ? [] : [other.id];
				}),
				now,
			),
		]);
		if (writing.status === "rejected") {
			throw writing.reason;
		}
		if (rechecking.status === "rejected") {
			throw rechecking.reason;
		}
		const passedIds = rechecking.value;
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
				{ notifiedAt: clock.now() },
			);
			if (outcome === "proposed") {
				proposed += 1;
			} else if (outcome === "held") {
				held += 1;
			}
		}
	}

	timer.lap("propose");

	// 集合の点数・保存・提案(F4b設計 §2.5)。1対1の提案の後に1集合だけ。失敗は隔離する(§5)
	let group: GroupOutcome | null = null;
	if (prep !== null) {
		try {
			group = await finishGroups(
				db,
				prep,
				plan.plannedSets,
				l4.axesByRow,
				now,
				() => clock.now(),
			);
		} catch (error) {
			groupFailed = 1;
			logger.warn("pipeline.group.failed", {
				intent_id: intentId,
				error_code: errorCodeOf(error),
			});
		}
	}

	groupMs += timer.take();
	timer.emit("group", groupMs);

	// 30分再評価抑制の起点を更新する(docs/05 §2.6)。提案が無いときのLの保存は
	// この更新の前に並べて同じバッチ(1往復)で送る(#36)。同じ文でJevの保留の印を
	// 書き直す(保留が無ければ消す・失敗の保留は連続回数を数える・docs/06 §2(k))
	const heldKind = await jevHeldKindOf(env, l4.run.held, clock.now());
	await runBatch(db, [
		...deferredScoreWrites,
		db
			.update(intents)
			.set({
				lastEvaluatedAt: now,
				jevHeldAt: heldKind === null ? null : now,
				jevHeldReason: heldKind,
				jevHeldCount:
					heldKind === "failed" ? sql`${intents.jevHeldCount} + 1` : 0,
			})
			.where(eq(intents.id, intentId)),
	]);

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
		supplementCount,
	};
	// 計測(Analytics Engine+ログ・docs/06 §7)。Cron呼び出しはこの計測のみを受け、
	// イベントpayloadへの反映は呼び出し側(consumer.ts)が行う
	writeStage2Metrics(
		env,
		{
			...result,
			latencyMs,
			origin: options?.origin ?? "cron_other",
			joinKey: crypto.randomUUID(),
		},
		// 本番の呼び出し元は共有の残り(キューのバッチ・scheduledの1回)を必ず渡す。ここは単体呼び出し用
		options?.metricsBudget ?? createMetricsBudget(),
	);
	timer.lap("finish");
	logger.info("pipeline.stage2.completed", {
		intent_id: intentId,
		count: result.l3Pass,
		latency: latencyMs,
		retrieval_count: retrievalCount,
		supplement_count: supplementCount,
	});
	return result;
};
