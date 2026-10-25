/**
 * match-eventsキューの消費(第1段)とDLQのdead反映(docs/06 §2・§5)。
 * 第1段: intent_created/intent_updated → Embedding計算 → VectorStoreへの
 * upsert(反映は待たない) → intents.embedding_model/embedded_at更新 →
 * 反映確認のvector_reflection(同version・遅延付き)の投入 → embedding_completedの行の
 * 記録(同version・キューへは送らない)。反映確認は反映後に1回だけ評価し直す
 * (pipeline/reflection.ts・同時に預けた相手の取りこぼしを拾う)。
 * 第1段が成功したら、同じ実行の中で第2段(runStage2)を続ける(キューの受け渡しを1回
 * 減らす・#30・不具合の修正工程(第3回)の設計 §3)。第2段は計算したベクトルで自分を
 * 検索するため、upsertの反映待ちは不要。続きの第2段が例外なら、embedding_completedの行の
 * idをベクトル付きでキューへ送り、今の第2段の経路(やり直し・DLQ)に任せる。その送信も
 * 失敗したら行はpendingのまま残り、10分の残留の掃査と未評価の回収(g)が拾う。
 * 消費は例外を外へ出さない(既定はack)。第1段の失敗(意思の読み取り・埋め込み・upsert・embedded_atの
 * 更新・投入)と反映確認の送り直しの失敗だけ、受け取ったメッセージを遅延付きでretryする。
 * 第1段の失敗は起点の行をpendingのまま残し、STAGE1_RETRY_DELAYS_S(10秒・30秒・60秒)で
 * やり直す。max_retriesを超えたものはDLQでdeadになり、Cronのバックフィル(e)が回収する
 * (06 §5・不具合の修正工程(第2回)の設計 §4)。投入だけの失敗の再配信は、埋め込み・
 * upsertを繰り返さず投入だけをやり直す。
 * 第2段(runStage2)はevaluateIntent(pipeline/evaluate.ts)へ委譲し、戻り値の計測結果を
 * embedding_completedの行のpayloadへ記録する(06 §7)。
 */
import { type MatchQueueMessage, PIPELINE } from "@latch/shared";
import { and, eq, gte, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchEvents, notifications } from "../db/schema";
import type { Env } from "../env";
import { createEmbedder } from "../llm/embedding";
import { createLogger } from "../logging/logger";
import { flushPush } from "../push/dispatch";
import { pushSenderOf } from "../push/sender";
import { createVectorStore } from "../vectorstore";
import { errorCodeOf } from "./errors";
import { evaluateIntent, stage2Payload } from "./evaluate";
import { emitMatchEvent, recordMatchEvent, sendToMatchQueue } from "./events";
import { createMetricsBudget, type MetricsBudget } from "./metrics-budget";
import { buildNormalizedText } from "./normalize";
import { saveRecentVector } from "./recent-vectors";
import { consumeReflectionEvent, type MatchEventRow } from "./reflection";

const logger = createLogger();

/** intents行の型(db/schemaの$inferSelect) */
export type IntentRow = typeof intents.$inferSelect;

/**
 * 1メッセージの消費の結果。undefined=ack(失敗も行のstatusに記録済み)・
 * { retryDelaySeconds }=受け取ったメッセージをその秒数の遅延でretryする
 * (max_retriesを超えたものはDLQでdeadになる)
 */
export type ConsumeOutcome = { retryDelaySeconds: number } | undefined;

/** 第1段の段(埋め込み・upsert・embedded_atの更新・後続イベントの投入) */
export type EmbeddingStageLayer = "embed" | "upsert" | "d1" | "emit";

/**
 * 第1段の本体の結果。embedded=計算したベクトル(直後の評価に渡す)と、キューの経路で
 * 記録したembedding_completedの行のid(Cronの経路は行を作らないのでundefined)・
 * failed=失敗した段(呼び出し側がやり直し方を決める・設計 §4)・
 * gone=埋め込みの間に意思の行が消えたか、activeでなくなったか、内容が直されて版が
 * 上がったため何も書かずに止めた(失敗ではない。削除の後の書き戻しの防止・#20・設計 §5.2。
 * 新しい版は、その版のイベントが埋め込む)
 */
export type EmbeddingStageResult =
	| { status: "embedded"; vector: number[]; completedEventId?: string }
	| { status: "failed"; layer: EmbeddingStageLayer }
	| { status: "gone" };

/**
 * 第1段の後続イベントを投入する。embedding_completed(emitCompleted=trueのとき・同version・
 * 即時・vector無し)→vector_reflection(同version・遅延付き)の順。embedding_completedを
 * 送るのは投入だけのやり直しの経路だけで、第1段の本体はvector_reflectionだけを送り、
 * embedding_completedは行の記録だけにして同じ実行で第2段を続ける(runEmbeddingStage・#30)
 * - skipの種別は投入しない(投入だけのやり直しで、送れている分を送り直さない)
 * - キューの経路(reflectionRequired=true)は、どちらの投入の失敗も例外のまま返し、
 *   呼び出し側がemitの段の失敗としてメッセージをretryする。使い切ったらDLQでdeadになり、
 *   評価は未評価の回収(g)が拾う(設計 §4)。送れなかった行は消し、「行がある=送れた」を保つ
 * - Cronの経路(reflectionRequired=false・やり直すメッセージが無い)はvector_reflectionの
 *   投入の失敗をログだけにする(評価はCronが直後に直接行う)
 */
const emitStage1Events = async (
	env: Env,
	intent: IntentRow,
	clock: Clock,
	options: {
		emitCompleted: boolean;
		reflectionRequired: boolean;
		skip?: ReadonlySet<"embedding_completed" | "vector_reflection">;
	},
): Promise<void> => {
	const discardOnSendFailure = options.reflectionRequired;
	// 第2段への再投入(同version・即時・docs/06 §2)
	if (
		options.emitCompleted &&
		options.skip?.has("embedding_completed") !== true
	) {
		await emitMatchEvent(
			env,
			{
				eventType: "embedding_completed",
				intentId: intent.id,
				version: intent.version,
			},
			{ discardOnSendFailure },
			clock,
		);
	}
	if (options.skip?.has("vector_reflection") === true) {
		return;
	}
	// 反映確認(同version・遅延付き・不具合の修正工程の設計 §2.1の4)。
	// emitCompleted=false(Cronのバックフィル・修復)でも投入し、同時投入の取りこぼしを拾う
	try {
		await emitMatchEvent(
			env,
			{
				eventType: "vector_reflection",
				intentId: intent.id,
				version: intent.version,
			},
			{ delaySeconds: PIPELINE.REFLECTION_DELAYS_S[0], discardOnSendFailure },
			clock,
		);
	} catch (error) {
		if (options.reflectionRequired) {
			throw error;
		}
		logger.warn("pipeline.reflection.emit_failed", {
			error_code: errorCodeOf(error, "REFLECTION_EMIT_FAILED"),
			intent_id: intent.id,
		});
	}
};

/**
 * 同versionの後続イベントのうち、すでに行がある(pending/processed=送れている)種別。
 * 投入だけのやり直しで、送れている分を飛ばすのに使う
 */
const emittedStage1Events = async (
	env: Env,
	intent: IntentRow,
): Promise<Set<"embedding_completed" | "vector_reflection">> => {
	const rows = await drizzle(env.DB)
		.select({ eventType: matchEvents.eventType })
		.from(matchEvents)
		.where(
			and(
				eq(matchEvents.sourceIntentId, intent.id),
				eq(matchEvents.version, intent.version),
				inArray(matchEvents.eventType, [
					"embedding_completed",
					"vector_reflection",
				]),
				inArray(matchEvents.status, ["pending", "processed"]),
			),
		);
	const emitted = new Set<"embedding_completed" | "vector_reflection">();
	for (const row of rows) {
		if (
			row.eventType === "embedding_completed" ||
			row.eventType === "vector_reflection"
		) {
			emitted.add(row.eventType);
		}
	}
	return emitted;
};

/**
 * 第1段を呼んだ経路(完了ログ・スキップのログのlayer)。inlineは意思を有効にした要求の
 * 応答の後の処理(processMatchEventInline・設計 §3.5)
 */
type Stage1Source = "queue" | "inline" | "backfill" | "repair";

/**
 * 第1段を何も書かずに止めたことを記録する(削除・一時停止・版の更新)。
 * 書き戻しの防止が働いた回数をstagingで数えるためのinfo(layer=呼び出した経路)
 */
const logStage1Skipped = (intentId: string, source: Stage1Source): void => {
	logger.info("pipeline.stage1.skipped", {
		intent_id: intentId,
		layer: source,
	});
};

/**
 * upsertのやり直しの待ちにばらつき(0.5〜1.5倍)を掛ける(LAT-100)。Vectorizeの
 * VECTOR_UPSERT_40041は同時の多数のupsertで出ており、同じ待ちでやり直すと同じ時刻に
 * またぶつかるため、要求ごとにずらす。0はそのまま0(試験の待ちなし)
 */
export const jitterUpsertRetryDelay = (
	delayMs: number,
	random: () => number = Math.random,
): number => Math.round(delayMs * (0.5 + random()));

/** 試験専用: upsertのやり直しの待ちの既定を差し替える(未設定なら定数・nullで戻す) */
let upsertRetryDelaysOverride: readonly number[] | null = null;
export const setStage1UpsertRetryDelaysForTest = (
	delays: readonly number[] | null,
): void => {
	upsertRetryDelaysOverride = delays;
};

/**
 * 第1段の本体(docs/06 §2)。埋め込み→VectorStoreへのupsert(反映は待たない)→
 * intents.embedding_model/embedded_atの更新→vector_reflectionの投入(同version・遅延付き)→
 * embedding_completedの行の記録(同version・キューへは送らない・#30)までを行い、
 * 成功(計算したベクトルと記録した行のid付き)/失敗(失敗した段付き)を返す。例外は外へ出さない。
 * 呼び出し側(consumeEvent)は成功の後に同じ実行で第2段(runStage2)を続ける。
 * vector_reflectionを先に送るのは、その送信が失敗してretryしたときにembedding_completedの
 * 行が残っていないようにするため(行があると投入だけのやり直しが「送れた」と見なして飛ばし、
 * 第2段が行われないまま残る)。行の記録が失敗したら同じくretryし、投入だけのやり直しが
 * embedding_completedをvector無しでキューへ送る。
 * 失敗の扱いは呼び出し側が決める(キューはメッセージのretry・設計 §4)。Cronのバックフィル
 * (docs/12 Task 12(e))からも再利用するためexportし、バックフィルは返ったベクトルで
 * 直後に評価する(本人のベクトルの反映を待たない・#22)。
 * options.emitCompleted=false はembedding_completedの行を作らない(既定true)。
 * Cronのバックフィルは直後にevaluateIntentを直接呼ぶため、投入すると二重評価になる
 * (docs/06 §2「Cronからは新たな起点イベントを発行しない」)。
 * vector_reflectionはemitCompletedによらず投入する(反映後の評価し直しで取りこぼしを拾う)
 */
export const runEmbeddingStage = async (
	env: Env,
	intent: IntentRow,
	clock: Clock,
	options: {
		emitCompleted?: boolean;
		/** 第1段を呼んだ経路(完了ログのlayer・既定queue) */
		source?: Stage1Source;
		/** upsertのやり直しの待ち(ミリ秒)。試験で短くするための上書き・既定は定数 */
		upsertRetryDelaysMs?: readonly number[];
	} = {},
): Promise<EmbeddingStageResult> => {
	const emitCompleted = options.emitCompleted ?? true;
	const source = options.source ?? "queue";
	const startedAt = clock.now().getTime();
	// いま実行中の段(embed/upsert/d1/emit)。失敗ログのlayerに載せて失敗した段を見分ける
	let layer: EmbeddingStageLayer = "embed";
	try {
		const embedder = createEmbedder(env);
		const values = await embedder.embed(buildNormalizedText(intent));
		// upsertの直前に意思の行を読み直す。埋め込みの間に削除・一時停止されていたら
		// 書かない(削除APIはベクトルを先に消すため、ここで書くと孤立したベクトルが残る・#20)。
		// 内容が直されて版が上がっていたら、古い版の結果は書かない(新しい版のイベントが
		// 埋め込む。古い版でembedded_atを書くと、投入だけのやり直しの判定を誤らせる)
		layer = "d1";
		const [current] = await drizzle(env.DB)
			.select({ status: intents.status, version: intents.version })
			.from(intents)
			.where(eq(intents.id, intent.id))
			.limit(1);
		if (
			current === undefined ||
			current.status !== "active" ||
			current.version !== intent.version
		) {
			logStage1Skipped(intent.id, source);
			return { status: "gone" };
		}
		layer = "upsert";
		const store = createVectorStore(env);
		// ベクトルid=Intent ULID・metadataはLayer 2のfilterに使う(docs/05 §2.3)。
		// 第1段はactive化済みのIntentのみで呼ばれるためformは非null
		// (draft→active化でform検証済み・docs/05 §2.2)
		const vectorToWrite = {
			id: intent.id,
			values,
			metadata: {
				form: intent.form as string,
				status: "active" as const,
				category: intent.category,
				user_id: intent.userId,
				version: intent.version,
			},
		};
		// upsertだけを短く待ってやり直す(#44)。Vectorizeの一時的な失敗は数秒で直ることが多く、
		// 応答の後の実行(上限30秒)に収まる最大10.5秒の待ち(ばらつき込み・LAT-100)で拾う。
		// 尽きたら最後の例外を投げ、従来どおり第1段の失敗(キューのやり直し)へ回る
		const retryDelays =
			options.upsertRetryDelaysMs ??
			upsertRetryDelaysOverride ??
			PIPELINE.STAGE1_UPSERT_RETRY_DELAYS_MS;
		for (let attempt = 0; ; attempt += 1) {
			try {
				await store.upsert([vectorToWrite]);
				break;
			} catch (error) {
				const delay = retryDelays[attempt];
				if (delay === undefined) {
					throw error;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, jitterUpsertRetryDelay(delay)),
				);
			}
		}
		layer = "d1";
		const db = drizzle(env.DB);
		// embedded_atは埋め込んだ版のときだけ書く(upsertの間に版が上がったら書かずに止める)
		const embeddedAt = clock.now();
		const updated = await db
			.update(intents)
			.set({ embeddingModel: embedder.modelId, embeddedAt })
			.where(
				and(eq(intents.id, intent.id), eq(intents.version, intent.version)),
			)
			.returning({ id: intents.id });
		if (updated.length === 0) {
			logStage1Skipped(intent.id, source);
			return { status: "gone" };
		}
		// 直近のベクトルの控え(#47)。Layer 2 Candidate Retrievalの照会の見落としを補うため、
		// embedded_atと同じ時刻・同じベクトルでD1にも書く(同じ意思は上書き)。バックフィルも
		// この本体を通るため同じく書かれる。失敗は例外にならずログだけ(第1段は成功のまま進む)
		await saveRecentVector(env.DB, intent.id, embeddedAt, values);
		layer = "emit";
		// キューの経路(embedding_completedの行を作る)だけが、投入の失敗をretryで
		// やり直せる。Cronの経路はvector_reflectionの失敗をログだけにする
		await emitStage1Events(env, intent, clock, {
			emitCompleted: false,
			reflectionRequired: emitCompleted,
		});
		// 第2段への受け渡し(同version・#30): キューへは送らず行だけを作り、呼び出し側が
		// 同じ実行で第2段を続ける。負荷試験の集計はこの行を使う(設計 §3.2)
		const completedEventId = emitCompleted
			? await recordMatchEvent(
					env,
					{
						eventType: "embedding_completed",
						intentId: intent.id,
						version: intent.version,
					},
					clock,
				)
			: undefined;
		// count=upsertしたベクトル数(1Intent=1ベクトル・06 §7の層別観測)・
		// layer=第1段を呼んだ経路(queue/inline/backfill/repair)
		logger.info("pipeline.stage1.completed", {
			intent_id: intent.id,
			count: 1,
			layer: source,
			latency: clock.now().getTime() - startedAt,
		});
		return { status: "embedded", vector: values, completedEventId };
	} catch (error) {
		logger.warn("pipeline.stage1.failed", {
			error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
			intent_id: intent.id,
			layer,
		});
		return { status: "failed", layer };
	}
};

/** 意思の行の読み取りが例外で終わった印(第1段のやり直しの判定に使う) */
const READ_FAILED = Symbol("READ_FAILED");

/**
 * 起点イベントをprocessedへ倒す。payloadの上書きがあれば合わせて記録する
 * (第2段の計測結果やskipped理由・docs/06 §7)
 */
const markProcessed = async (
	env: Env,
	eventId: string,
	clock: Clock,
	payload?: Record<string, unknown>,
): Promise<void> => {
	await drizzle(env.DB)
		.update(matchEvents)
		.set({
			status: "processed",
			...(payload !== undefined ? { payload } : {}),
			processedAt: clock.now(),
		})
		.where(eq(matchEvents.id, eventId));
};

/** 起点イベントをfailedへ倒す(第2段の評価の失敗・06 §5)。processedAtは記録しない */
const markFailed = async (env: Env, eventId: string): Promise<void> => {
	await drizzle(env.DB)
		.update(matchEvents)
		.set({ status: "failed" })
		.where(eq(matchEvents.id, eventId));
};

/**
 * 第2段の本体(docs/06 §2〜§3)。古いversionのembedding_completedは評価せずstale_versionで
 * processedにする(評価するとlast_evaluated_atが書かれ、新しいversionの評価が30分抑制に
 * かかるため)。それ以外はevaluateIntent(Layer 2 Candidate Retrieval→Layer 1→Layer 3→
 * 候補保存)へ委譲し、戻り値の計測結果を行のpayloadへ記録してprocessedにする(06 §7)。
 * evaluateIntentがnull(抑制・対象外)ならskippedを載せる。評価の例外は投げ返す
 * (キューの経路はfailedへ倒し、第1段の続きの経路はキューへ送って任せる)
 */
const runStage2 = async (
	env: Env,
	event: MatchEventRow,
	clock: Clock,
	metricsBudget: MetricsBudget,
	vector?: number[],
): Promise<void> => {
	const [current] = await drizzle(env.DB)
		.select({ version: intents.version })
		.from(intents)
		.where(eq(intents.id, event.sourceIntentId))
		.limit(1);
	if (current !== undefined && current.version !== event.version) {
		await markProcessed(env, event.id, clock, { skipped: "stale_version" });
		return;
	}
	const result = await evaluateIntent(env, event.sourceIntentId, clock, {
		vector,
		origin: "embedding_completed",
		metricsBudget,
	});
	await markProcessed(
		env,
		event.id,
		clock,
		result === null ? { skipped: "suppressed" } : stage2Payload(result),
	);
};

/**
 * 第1段の成功の後に、同じ実行で第2段を続ける(#30・設計 §3.2)。記録したembedding_completedの
 * 行がpendingのときだけ評価する(UNIQUE衝突で見つけた処理済みの行は評価し直さない)。
 * 例外なら第2段の失敗をログし、行のidをベクトル付きでキューへ送って今の第2段の経路
 * (やり直し・DLQ)に任せる。送信も失敗したらログだけにし、行はpendingのまま残して10分の
 * 残留の掃査と未評価の回収(g)に任せる。例外は外へ出さない
 */
const continueStage2 = async (
	env: Env,
	completedEventId: string,
	intentId: string,
	clock: Clock,
	metricsBudget: MetricsBudget,
	vector: number[],
): Promise<void> => {
	try {
		const [completed] = await drizzle(env.DB)
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, completedEventId))
			.limit(1);
		if (completed === undefined || completed.status !== "pending") {
			return;
		}
		await runStage2(env, completed, clock, metricsBudget, vector);
	} catch (error) {
		logger.warn("pipeline.stage2.failed", {
			error_code: errorCodeOf(error),
			intent_id: intentId,
		});
		try {
			await sendToMatchQueue(env, completedEventId, { vector });
		} catch (sendError) {
			logger.warn("pipeline.stage2.handoff_failed", {
				error_code: errorCodeOf(sendError, "STAGE2_HANDOFF_FAILED"),
				intent_id: intentId,
			});
		}
	}
};

/**
 * 通常キューの1メッセージを処理する(docs/06 §2の処理枝)。
 * 失敗はD1のイベント行statusで記録し、ここでは例外を握って呼び出し側へは
 * 正常復帰する(ackが原則・06 §5)。やり直すべき一時的な失敗だけを
 * { retryDelaySeconds }で返す(第1段の失敗・#17、反映確認の送り直しの失敗・#23)。
 * attemptsはこのメッセージの配信の回数(1始まり)で、第1段の遅延の選択に使う。
 * pathは処理した経路(既定queue・応答の後の処理はinline)。intent_createdの起点の行を
 * processedにするとき、payloadに{ path }を載せる(既存の項目は保つ)。負荷試験の集計が
 * 初期判定の行の経路の内訳をD1から数えるための印で、処理は変えない
 */
const consumeEvent = async (
	env: Env,
	eventId: string,
	clock: Clock,
	message: { vector?: number[]; attempts: number; path?: "queue" | "inline" },
	metricsBudget: MetricsBudget,
): Promise<ConsumeOutcome> => {
	const { vector, attempts } = message;
	const path = message.path ?? "queue";
	const db = drizzle(env.DB);
	// イベント行の取得。無ければ何もせずack(送信だけが先行したメッセージ・Task 6引継ぎ)
	const [event] = await db
		.select()
		.from(matchEvents)
		.where(eq(matchEvents.id, eventId))
		.limit(1);
	if (event === undefined) {
		return;
	}
	// 処理済みイベントの再消費はスキップ(冪等・docs/06 §2)
	if (event.status === "processed") {
		return;
	}
	// vector_reflection(反映確認・不具合の修正工程の設計 §2.3)
	if (event.eventType === "vector_reflection") {
		return consumeReflectionEvent(env, event, clock, metricsBudget);
	}
	// embedding_completed(第2段・docs/06 §2〜§3): 第1段の続きの評価が失敗して送られた
	// もの・投入だけのやり直しで送られたもの。本体はrunStage2(第1段の続きと共用)
	if (event.eventType === "embedding_completed") {
		try {
			await runStage2(env, event, clock, metricsBudget, vector);
		} catch (error) {
			// 第2段の失敗は第1段のログと分けて記録し、起点イベントをfailedへ倒す
			// (再試行なし・06 §5。Cronの未評価回収が拾う)
			logger.warn("pipeline.stage2.failed", {
				error_code: errorCodeOf(error),
				intent_id: event.sourceIntentId,
			});
			await markFailed(env, event.id);
		}
		return;
	}
	const stage1 =
		event.eventType === "intent_created" ||
		event.eventType === "intent_updated";
	// 起点の行をprocessedへ倒す。intent_createdは処理した経路の印pathを載せる
	// (既存のpayloadの項目は保つ)。それ以外の種別は今までどおり
	const markOrigin = (payload?: Record<string, unknown>): Promise<void> => {
		if (event.eventType !== "intent_created") {
			return markProcessed(env, event.id, clock, payload);
		}
		const existing =
			typeof event.payload === "object" &&
			event.payload !== null &&
			!Array.isArray(event.payload)
				? (event.payload as Record<string, unknown>)
				: {};
		return markProcessed(env, event.id, clock, {
			...existing,
			...payload,
			path,
		});
	};
	// 第1段の失敗のやり直し(設計 §4)。起点の行はpendingのまま残し、配信の回数に
	// 応じた遅延でretryする(max_retriesを超えたらDLQでdead→Cronのバックフィル(e))
	const retry = {
		retryDelaySeconds:
			PIPELINE.STAGE1_RETRY_DELAYS_S[
				Math.min(
					Math.max(attempts, 1) - 1,
					PIPELINE.STAGE1_RETRY_DELAYS_S.length - 1,
				)
			],
	};
	// 意思の行を読む。第1段では読み取りの一時的な失敗(D1_ERROR等)もやり直す
	// (ackすると未処理の回収とバックフィルまで待つことになる)
	const readIntent = async (): Promise<
		IntentRow | undefined | typeof READ_FAILED
	> => {
		try {
			const [row] = await db
				.select()
				.from(intents)
				.where(eq(intents.id, event.sourceIntentId))
				.limit(1);
			return row;
		} catch (error) {
			if (!stage1) {
				throw error;
			}
			logger.warn("pipeline.stage1.failed", {
				error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
				intent_id: event.sourceIntentId,
				layer: "d1",
			});
			return READ_FAILED;
		}
	};
	const intent = await readIntent();
	if (intent === READ_FAILED) {
		return retry;
	}
	// 本体行が消えている(削除競合)なら処理対象なしとしてprocessedへ
	if (intent === undefined) {
		await markOrigin();
		return;
	}
	// 古いversionのイベントは破棄する(更新の10秒遅延配信の間に次の更新が来た場合・06 §2)
	if (event.version !== intent.version) {
		await markOrigin({ skipped: "stale_version" });
		return;
	}
	// 非active(draft/paused/expired)は評価対象外(docs/06 §2)
	if (intent.status !== "active") {
		await markOrigin();
		return;
	}
	if (stage1) {
		// upsert直前の再読込: 最初の読み取り〜ここまでの間の削除で
		// 孤立ベクトルを作らない(台帳引継ぎ・docs/06 §5)
		const current = await readIntent();
		if (current === READ_FAILED) {
			return retry;
		}
		if (current === undefined || current.status !== "active") {
			await markOrigin();
			return;
		}
		// 投入だけの失敗の再配信: このイベントの後に同versionの埋め込みが書かれていれば
		// (embedded_atは埋め込んだ版のときだけ書かれる・runEmbeddingStage)、
		// 埋め込み・upsertを繰り返さず、まだ送れていない後続イベントだけを投入する
		// (行がある種別は送れているので飛ばす)。ベクトルは保持していないため
		// embedding_completedはvector無しで送る(第2段はgetByIdsで読み、未反映なら
		// 何もしない。取りこぼしは反映確認の評価し直しが拾う)
		if (
			current.version === event.version &&
			current.embeddedAt !== null &&
			current.embeddedAt.getTime() >= event.createdAt.getTime()
		) {
			try {
				await emitStage1Events(env, current, clock, {
					emitCompleted: true,
					reflectionRequired: true,
					skip: await emittedStage1Events(env, current),
				});
			} catch (error) {
				logger.warn("pipeline.stage1.failed", {
					error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
					intent_id: current.id,
					layer: "emit",
				});
				return retry;
			}
			await markOrigin();
			return;
		}
		const result = await runEmbeddingStage(env, current, clock, {
			source: path,
		});
		if (result.status === "failed") {
			return retry;
		}
		// embedded・gone(埋め込みの間の削除・一時停止で書かずに止めた)はどちらもprocessedへ
		// (goneは上の「本体行が消えている」と同じ扱いでやり直さない・#20)
		await markOrigin();
		// 成功したら同じ実行で第2段を続ける(#30)。ここで作られた提案の通知は、
		// このメッセージの処理の後のflushFreshPushで送り出される(#19)
		if (result.status === "embedded" && result.completedEventId !== undefined) {
			await continueStage2(
				env,
				result.completedEventId,
				current.id,
				clock,
				metricsBudget,
				result.vector,
			);
		}
		return;
	}
	// 第1段の未対応種別(将来追加分)は何もせず保持する(ackのみ)
};

/**
 * 開始時刻以降に作られた通知があれば、その送出をwaitUntilで始める(待たない)。
 * 判定は「createdAtが開始時刻以降の通知が1件でもあるか」の1回の照会。
 * バッチの最後の送出と重なっても、flushPushは1文の条件付きUPDATEで順番を取るので
 * 同じ通知は1回しか送られない。失敗はログだけ(取りこぼしはバッチの最後の送出とCronが担う)
 */
const flushFreshPush = async (
	env: Env,
	ctx: Pick<ExecutionContext, "waitUntil">,
	clock: Clock,
	startedAt: Date,
): Promise<void> => {
	try {
		const db = drizzle(env.DB);
		const [created] = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(gte(notifications.createdAt, startedAt))
			.limit(1);
		if (created === undefined) {
			return;
		}
		ctx.waitUntil(
			flushPush(db, pushSenderOf(env), clock, {
				minAgeMs: 0,
				createdFrom: startedAt,
			}).catch((error) => {
				logger.warn("push.flush.failed", {
					error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
				});
			}),
		);
	} catch (error) {
		logger.warn("push.flush.failed", {
			error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
		});
	}
};

/**
 * 1つのイベントを、キューの1メッセージの処理と同じ形で、キューを通さずに処理する
 * (#30・オーナー決定3b・不具合の修正工程(第3回)の設計 §3.5)。意思を有効にした要求
 * (activeでの作成・下書きの有効化)の応答の後(waitUntil)から、intent_createdの行を
 * 作り終えた後に同じ行のidで呼ぶ。処理はconsumeEvent(第1段→同じ実行の第2段)→
 * このイベントで作られた通知の送出(flushFreshPush)。計測の書き込みの残りはこの呼び出し
 * ごとに1つ作る(同時に動く別の要求と共有しない・#28)。
 * 消費の結果がやり直し(retry)なら何もしない。行はpendingのまま残り、遅らせて送った
 * キューのメッセージ(PIPELINE.INLINE_FALLBACK_DELAY_S)がやり直す。済んでいれば、その
 * メッセージは今の冪等の仕組み(processedは何もしない)で何もせずに終わる。
 * 例外は外へ出さず、pipeline.inline.failed(error_code・intent_id)を出す
 */
export const processMatchEventInline = async (
	env: Env,
	eventId: string,
	// 使うのはwaitUntilだけ(HonoのexecutionCtxもそのまま渡せる)
	ctx: Pick<ExecutionContext, "waitUntil">,
	clock: Clock,
): Promise<void> => {
	const startedAt = clock.now();
	try {
		const outcome = await consumeEvent(
			env,
			eventId,
			clock,
			{ attempts: 1, path: "inline" },
			createMetricsBudget(),
		);
		if (outcome !== undefined) {
			return;
		}
		await flushFreshPush(env, ctx, clock, startedAt);
	} catch (error) {
		// intent_idは行から読み直す(読めなければ載せない・許可リストの項目だけ)
		let intentId: string | undefined;
		try {
			const [event] = await drizzle(env.DB)
				.select({ sourceIntentId: matchEvents.sourceIntentId })
				.from(matchEvents)
				.where(eq(matchEvents.id, eventId))
				.limit(1);
			intentId = event?.sourceIntentId;
		} catch {
			// 読めなくても失敗のログは出す
		}
		logger.warn("pipeline.inline.failed", {
			error_code: errorCodeOf(error, "INLINE_PIPELINE_FAILED"),
			...(intentId !== undefined ? { intent_id: intentId } : {}),
		});
	}
};

/**
 * 通常キュー(match-events)のバッチを処理する。1メッセージの例外でバッチ全体を倒さない。
 * 消費の結果がretryならそのメッセージだけを遅延付きでretryし、それ以外はack(既定)
 */
const handleMainQueueBatch = async (
	env: Env,
	batch: MessageBatch<MatchQueueMessage>,
	ctx: ExecutionContext,
	clock: Clock,
): Promise<void> => {
	// このバッチの計測の書き込みの残り(バッチごとに作る・同時に動く別のバッチと共有しない・#28)
	const metricsBudget = createMetricsBudget();
	for (const message of batch.messages) {
		const eventId = message.body?.event_id;
		// 本体が不正なメッセージは評価できずackで破棄する
		if (typeof eventId !== "string") {
			continue;
		}
		// このメッセージの処理の開始時刻。これ以降に作られた通知だけをその場で送る(#19)
		const startedAt = clock.now();
		try {
			const body = message.body;
			// 空でない数値の配列だけを第2段へ渡す(空配列で照会しない)
			const vector =
				Array.isArray(body.vector) &&
				body.vector.length > 0 &&
				body.vector.every((v) => typeof v === "number")
					? body.vector
					: undefined;
			const outcome = await consumeEvent(
				env,
				eventId,
				clock,
				{
					vector,
					attempts: message.attempts,
				},
				metricsBudget,
			);
			if (outcome !== undefined) {
				message.retry({ delaySeconds: outcome.retryDelaySeconds });
			}
			// このメッセージで通知が作られていれば、バッチの終わりを待たずに送り出す
			// (長いバッチの先頭で作った提案のWeb Pushが最後まで待たされない・#19)
			await flushFreshPush(env, ctx, clock, startedAt);
		} catch (error) {
			// 個別消費の失敗は再試行せずack(06 §5の設計)。intent_idはこの時点で
			// 特定できないため記録しない(許可フィールドのみ・docs/08 §6)
			logger.warn("pipeline.stage1.failed", {
				error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
			});
		}
	}
};

/**
 * DLQ(match-events-dlq)のバッチを処理する(docs/06 §5)。各メッセージの
 * event_idに対応するイベント行をstatus=deadへ隔離し、warnで警報する。
 * 再処理はUNIQUE衝突を避けるため新規イベントとして手動で再発行する
 */
const handleDlqBatch = async (
	env: Env,
	batch: MessageBatch<MatchQueueMessage>,
): Promise<void> => {
	const db = drizzle(env.DB);
	let deadCount = 0;
	for (const message of batch.messages) {
		const eventId = message.body?.event_id;
		if (typeof eventId !== "string") {
			continue;
		}
		const rows = await db
			.update(matchEvents)
			.set({ status: "dead" })
			.where(eq(matchEvents.id, eventId))
			.returning({ id: matchEvents.id });
		deadCount += rows.length;
	}
	logger.warn("pipeline.dlq.dead", { count: deadCount });
};

/**
 * DLQのキュー名か。環境ごとに名前の後ろへ印が付く(local・prod=match-events-dlq・
 * staging=match-events-dlq-staging・wrangler.jsonc)。consumerのキュー名は実行時に
 * バインディングから読めないため、名前の形で判別する。主キュー(match-events・
 * match-events-staging)は「-dlq」を含まないので外れる(docs/06 §5)
 */
export const isDlqQueue = (queueName: string): boolean =>
	/^match-events-dlq(-[a-z0-9]+)?$/.test(queueName);

/**
 * Queuesのバッチ消費の入口(index.tsのqueueハンドラから呼ぶ)。
 * キュー名はbatch.queueで判別し、例外を外へ出さない(既定はack)。
 * batch全体のretryは使わない設計で、失敗はイベント行のstatusで記録する(06 §5)。
 * メッセージ単位のretryは消費の結果(ConsumeOutcome)が求めたときだけ行う
 */
export const handleQueueBatch = async (
	batch: MessageBatch<MatchQueueMessage>,
	env: Env,
	ctx: ExecutionContext,
	clock: Clock,
): Promise<void> => {
	// この実行の開始時刻。これより前に作られた未送信は毎分Cronの回収に任せる(#39)
	const startedAt = clock.now();
	try {
		if (isDlqQueue(batch.queue)) {
			await handleDlqBatch(env, batch);
			return;
		}
		await handleMainQueueBatch(env, batch, ctx, clock);
		// 提案化・成立で作られた通知をその場で送り出す(F7b設計 §5.1 手順2)。
		// 失敗はログだけ(取りこぼしはCronの回収が担う・§5.6)
		ctx.waitUntil(
			(async () => {
				try {
					await flushPush(drizzle(env.DB), pushSenderOf(env), clock, {
						minAgeMs: 0,
						createdFrom: startedAt,
					});
				} catch (error) {
					logger.warn("push.flush.failed", {
						error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
					});
				}
			})(),
		);
	} catch (error) {
		// 最終安全網: 例外を外へ出さずackする(失敗はメッセージごとの記録に努める)
		logger.warn("pipeline.stage1.failed", {
			error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
		});
	}
};
