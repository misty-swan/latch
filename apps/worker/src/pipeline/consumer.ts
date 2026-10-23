/**
 * match-eventsキューの消費(第1段)とDLQのdead反映(docs/06 §2・§5)。
 * 第1段: intent_created/intent_updated → Embedding計算 → VectorStoreへの
 * upsert(反映は待たない) → intents.embedding_model/embedded_at更新 →
 * 計算したベクトルを載せたembedding_completedイベントの再投入(同version・即時)。
 * 第2段は載せられたベクトルで自分を検索するため、upsertの反映待ちは不要。
 * 続けて反映確認のvector_reflection(同version・遅延付き)を投入し、反映後に
 * 1回だけ評価し直す(pipeline/reflection.ts・同時に預けた相手の取りこぼしを拾う)。
 * 消費は例外を外へ出さない(既定はack)。第1段の失敗(埋め込み・upsert・embedded_atの
 * 更新・投入)と反映確認の送り直しの失敗だけ、受け取ったメッセージを遅延付きでretryする。
 * 第1段の失敗は起点の行をpendingのまま残し、STAGE1_RETRY_DELAYS_S(10秒・30秒・60秒)で
 * やり直す。max_retriesを超えたものはDLQでdeadになり、Cronのバックフィル(e)が回収する
 * (06 §5・不具合の修正工程(第2回)の設計 §4)。投入だけの失敗の再配信は、埋め込み・
 * upsertを繰り返さず投入だけをやり直す。
 * embedding_completedの消費(第2段)はevaluateIntent(pipeline/evaluate.ts)へ
 * 委譲し、戻り値の計測結果を起点イベントのpayloadへ記録する(06 §7)。
 */
import { type MatchQueueMessage, PIPELINE } from "@latch/shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchEvents } from "../db/schema";
import type { Env } from "../env";
import { createEmbedder } from "../llm/embedding";
import { createLogger } from "../logging/logger";
import { flushPush } from "../push/dispatch";
import { pushSenderOf } from "../push/sender";
import { createVectorStore } from "../vectorstore";
import { errorCodeOf } from "./errors";
import { evaluateIntent, stage2Payload } from "./evaluate";
import { emitMatchEvent } from "./events";
import { buildNormalizedText } from "./normalize";
import { consumeReflectionEvent } from "./reflection";

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
 * 第1段の本体の結果。embedded=計算したベクトル(直後の評価に渡す)・
 * failed=失敗した段(呼び出し側がやり直し方を決める・設計 §4)・
 * gone=埋め込みの間に意思の行が消えたかactiveでなくなったため何も書かずに止めた
 * (失敗ではない。削除の後の書き戻しの防止・#20・設計 §5.2)
 */
export type EmbeddingStageResult =
	| { status: "embedded"; vector: number[] }
	| { status: "failed"; layer: EmbeddingStageLayer }
	| { status: "gone" };

/**
 * 第1段の後続イベントを投入する。embedding_completed(emitCompleted=trueのとき・同version・
 * 即時。vectorがあればメッセージに載せる)→vector_reflection(同version・遅延付き)の順。
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
		vector?: number[];
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
			{ vector: options.vector, discardOnSendFailure },
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
 * 第1段の本体(docs/06 §2)。埋め込み→VectorStoreへのupsert(反映は待たない)→
 * intents.embedding_model/embedded_atの更新→embedding_completedイベント(vector付き)の投入
 * (同version・即時)→vector_reflectionの投入(同version・遅延付き)までを行い、
 * 成功(計算したベクトル付き)/失敗(失敗した段付き)を返す。例外は外へ出さない。
 * 失敗の扱いは呼び出し側が決める(キューはメッセージのretry・設計 §4)。Cronのバックフィル
 * (docs/12 Task 12(e))からも再利用するためexportし、バックフィルは返ったベクトルで
 * 直後に評価する(本人のベクトルの反映を待たない・#22)。
 * options.emitCompleted=false はembedding_completedを投入しない(既定true)。
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
		source?: "queue" | "backfill" | "repair";
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
		// 書かない(削除APIはベクトルを先に消すため、ここで書くと孤立したベクトルが残る・#20)
		layer = "d1";
		const [current] = await drizzle(env.DB)
			.select({ status: intents.status })
			.from(intents)
			.where(eq(intents.id, intent.id))
			.limit(1);
		if (current === undefined || current.status !== "active") {
			return { status: "gone" };
		}
		layer = "upsert";
		const store = createVectorStore(env);
		// ベクトルid=Intent ULID・metadataはLayer 2のfilterに使う(docs/05 §2.3)。
		// 第1段はactive化済みのIntentのみで呼ばれるためformは非null
		// (draft→active化でform検証済み・docs/05 §2.2)
		await store.upsert([
			{
				id: intent.id,
				values,
				metadata: {
					form: intent.form as string,
					status: "active",
					category: intent.category,
					user_id: intent.userId,
					version: intent.version,
				},
			},
		]);
		layer = "d1";
		const db = drizzle(env.DB);
		await db
			.update(intents)
			.set({ embeddingModel: embedder.modelId, embeddedAt: clock.now() })
			.where(eq(intents.id, intent.id));
		layer = "emit";
		// キューの経路(embedding_completedを投入する)だけが、投入の失敗をretryで
		// やり直せる。Cronの経路はvector_reflectionの失敗をログだけにする
		await emitStage1Events(env, intent, clock, {
			emitCompleted,
			reflectionRequired: emitCompleted,
			vector: values,
		});
		// count=upsertしたベクトル数(1Intent=1ベクトル・06 §7の層別観測)・
		// layer=第1段を呼んだ経路(queue/backfill/repair)
		logger.info("pipeline.stage1.completed", {
			intent_id: intent.id,
			count: 1,
			layer: source,
			latency: clock.now().getTime() - startedAt,
		});
		return { status: "embedded", vector: values };
	} catch (error) {
		logger.warn("pipeline.stage1.failed", {
			error_code: errorCodeOf(error, "EMBEDDING_FAILED"),
			intent_id: intent.id,
			layer,
		});
		return { status: "failed", layer };
	}
};

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
 * 通常キューの1メッセージを処理する(docs/06 §2の処理枝)。
 * 失敗はD1のイベント行statusで記録し、ここでは例外を握って呼び出し側へは
 * 正常復帰する(ackが原則・06 §5)。やり直すべき一時的な失敗だけを
 * { retryDelaySeconds }で返す(第1段の失敗・#17、反映確認の送り直しの失敗・#23)。
 * attemptsはこのメッセージの配信の回数(1始まり)で、第1段の遅延の選択に使う
 */
const consumeEvent = async (
	env: Env,
	eventId: string,
	clock: Clock,
	message: { vector?: number[]; attempts: number },
): Promise<ConsumeOutcome> => {
	const { vector, attempts } = message;
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
		return consumeReflectionEvent(env, event, clock);
	}
	// embedding_completed(第2段・docs/06 §2〜§3): 評価実行(Layer 2検索→
	// Layer 1→Layer 3→候補保存)をevaluateIntentへ委譲し、戻り値の計測結果を
	// 起点イベントのpayloadへ記録する(docs/06 §7のイベント単位の計測)。
	// evaluateIntentがnull(抑制・対象外)のときはskippedを載せてprocessedへ倒す
	if (event.eventType === "embedding_completed") {
		// 古いversionの第2段は評価しない。評価するとlast_evaluated_atが書かれ、
		// 新しいversionの評価が30分抑制にかかるため
		const [current] = await db
			.select({ version: intents.version })
			.from(intents)
			.where(eq(intents.id, event.sourceIntentId))
			.limit(1);
		if (current !== undefined && current.version !== event.version) {
			await markProcessed(env, event.id, clock, { skipped: "stale_version" });
			return;
		}
		let result: Awaited<ReturnType<typeof evaluateIntent>>;
		try {
			result = await evaluateIntent(env, event.sourceIntentId, clock, {
				vector,
				origin: "embedding_completed",
			});
		} catch (error) {
			// 第2段の失敗は第1段のログと分けて記録し、起点イベントをfailedへ倒す
			// (再試行なし・06 §5。Cronの未評価回収が拾う)
			logger.warn("pipeline.stage2.failed", {
				error_code: errorCodeOf(error),
				intent_id: event.sourceIntentId,
			});
			await markFailed(env, event.id);
			return;
		}
		await markProcessed(
			env,
			event.id,
			clock,
			result === null ? { skipped: "suppressed" } : stage2Payload(result),
		);
		return;
	}
	const [intent] = await db
		.select()
		.from(intents)
		.where(eq(intents.id, event.sourceIntentId))
		.limit(1);
	// 本体行が消えている(削除競合)なら処理対象なしとしてprocessedへ
	if (intent === undefined) {
		await markProcessed(env, event.id, clock);
		return;
	}
	// 古いversionのイベントは破棄する(更新の10秒遅延配信の間に次の更新が来た場合・06 §2)
	if (event.version !== intent.version) {
		await markProcessed(env, event.id, clock, { skipped: "stale_version" });
		return;
	}
	// 非active(draft/paused/expired)は評価対象外(docs/06 §2)
	if (intent.status !== "active") {
		await markProcessed(env, event.id, clock);
		return;
	}
	if (
		event.eventType === "intent_created" ||
		event.eventType === "intent_updated"
	) {
		// upsert直前の再読込: 最初の読み取り〜ここまでの間の削除で
		// 孤立ベクトルを作らない(台帳引継ぎ・docs/06 §5)
		const [current] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intent.id))
			.limit(1);
		if (current === undefined || current.status !== "active") {
			await markProcessed(env, event.id, clock);
			return;
		}
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
		// 投入だけの失敗の再配信: このイベントの後に同versionの埋め込みが書かれていれば、
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
			await markProcessed(env, event.id, clock);
			return;
		}
		const result = await runEmbeddingStage(env, current, clock);
		if (result.status === "failed") {
			return retry;
		}
		// embedded・gone(埋め込みの間の削除・一時停止で書かずに止めた)はどちらもprocessedへ
		// (goneは上の「本体行が消えている」と同じ扱いでやり直さない・#20)
		await markProcessed(env, event.id, clock);
		return;
	}
	// 第1段の未対応種別(将来追加分)は何もせず保持する(ackのみ)
};

/**
 * 通常キュー(match-events)のバッチを処理する。1メッセージの例外でバッチ全体を倒さない。
 * 消費の結果がretryならそのメッセージだけを遅延付きでretryし、それ以外はack(既定)
 */
const handleMainQueueBatch = async (
	env: Env,
	batch: MessageBatch<MatchQueueMessage>,
	clock: Clock,
): Promise<void> => {
	for (const message of batch.messages) {
		const eventId = message.body?.event_id;
		// 本体が不正なメッセージは評価できずackで破棄する
		if (typeof eventId !== "string") {
			continue;
		}
		try {
			const body = message.body;
			// 空でない数値の配列だけを第2段へ渡す(空配列で照会しない)
			const vector =
				Array.isArray(body.vector) &&
				body.vector.length > 0 &&
				body.vector.every((v) => typeof v === "number")
					? body.vector
					: undefined;
			const outcome = await consumeEvent(env, eventId, clock, {
				vector,
				attempts: message.attempts,
			});
			if (outcome !== undefined) {
				message.retry({ delaySeconds: outcome.retryDelaySeconds });
			}
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
	try {
		if (isDlqQueue(batch.queue)) {
			await handleDlqBatch(env, batch);
			return;
		}
		await handleMainQueueBatch(env, batch, clock);
		// 提案化・成立で作られた通知をその場で送り出す(F7b設計 §5.1 手順2)。
		// 失敗はログだけ(取りこぼしはCronの回収が担う・§5.6)
		ctx.waitUntil(
			(async () => {
				try {
					await flushPush(drizzle(env.DB), pushSenderOf(env), clock, {
						minAgeMs: 0,
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
