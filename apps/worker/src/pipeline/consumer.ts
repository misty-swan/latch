/**
 * match-eventsキューの消費(第1段)とDLQのdead反映(docs/06 §2・§5)。
 * 第1段: intent_created/intent_updated → Embedding計算 → VectorStoreへの
 * upsert → 反映確認(getByIds) → intents.embedding_model/embedded_at更新 →
 * embedding_completedイベントの再投入(同version・即時)。
 * 消費は例外を外へ出さない(=全メッセージack)。失敗はイベント行のstatusで
 * 記録し、Embedding失敗は再試行せずCronのバックフィルが回収する(06 §5)。
 * embedding_completedの消費(第2段)はevaluateIntent(pipeline/evaluate.ts)へ
 * 委譲し、戻り値の計測結果を起点イベントのpayloadへ記録する(06 §7)。
 */
import type { MatchQueueMessage } from "@latch/shared";
import { PIPELINE } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchEvents } from "../db/schema";
import type { Env } from "../env";
import { createEmbedder } from "../llm/embedding";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import type { VectorStore } from "../vectorstore/types";
import { evaluateIntent } from "./evaluate";
import { emitMatchEvent } from "./events";
import { buildNormalizedText } from "./normalize";

const logger = createLogger();

/** intents行の型(db/schemaの$inferSelect) */
export type IntentRow = typeof intents.$inferSelect;

/** 第1段の本体の結果。failed=Embedding系の失敗(再試行なし・06 §5) */
export type EmbeddingStageResult = "embedded" | "failed";

/**
 * エラーメッセージ先頭のコード部(「CODE: 〜」形式・llm/embedding.tsの規約)を
 * 取り出す。コード形式でないメッセージはEMBEDDING_FAILEDに倒す
 */
const errorCodeOf = (error: unknown): string => {
	const raw = error instanceof Error ? error.message : String(error);
	const code = raw.split(":")[0]?.trim() ?? "";
	return /^[A-Z0-9_]+$/.test(code) ? code : "EMBEDDING_FAILED";
};

/** 実時間のsleep(反映確認のポーリング間隔用) */
const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * VectorStoreへのupsert反映を確認する(docs/06 §2: upsert完了を確認してから
 * embedding_completedを投入)。EMBED_CONFIRM_INTERVAL_MS間隔でgetByIdsを詰め、
 * EMBED_CONFIRM_TIMEOUT_MSを超過したら未反映(false)と判定する。
 * インメモリ実装(local・単体試験)は即時に反映されるため初回で確定する。
 * 反復回数にも上限を設け、時刻が進まないclockとの組合せでも停止するようにする
 */
const waitUntilReflected = async (
	store: VectorStore,
	vectorId: string,
	clock: Clock,
): Promise<boolean> => {
	const startedAt = clock.now().getTime();
	const maxAttempts =
		Math.floor(
			PIPELINE.EMBED_CONFIRM_TIMEOUT_MS / PIPELINE.EMBED_CONFIRM_INTERVAL_MS,
		) + 1;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const [hit] = await store.getByIds([vectorId]);
		if (hit !== null) {
			return true;
		}
		if (
			clock.now().getTime() - startedAt >=
			PIPELINE.EMBED_CONFIRM_TIMEOUT_MS
		) {
			return false;
		}
		await sleep(PIPELINE.EMBED_CONFIRM_INTERVAL_MS);
	}
	return false;
};

/**
 * 第1段の本体(docs/06 §2)。埋め込み→VectorStoreへのupsert→反映確認→
 * intents.embedding_model/embedded_atの更新→embedding_completedイベントの投入
 * (同version・即時)までを行い、成功("embedded")/失敗("failed")を返す。
 * 失敗(throw/timeout)は再試行せず、呼び出し側が起点イベントをfailedへ倒す
 * (06 §5: 再試行なし・Cronのバックフィルが回収)。Cronのバックフィル
 * (docs/12 Task 12(e))からも再利用するためexportする
 */
export const runEmbeddingStage = async (
	env: Env,
	intent: IntentRow,
	clock: Clock,
): Promise<EmbeddingStageResult> => {
	const startedAt = clock.now().getTime();
	try {
		const embedder = createEmbedder(env);
		const values = await embedder.embed(buildNormalizedText(intent));
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
				},
			},
		]);
		// 反映確認(06 §2: upsert反映は秒単位で遅れ得るため完了を待ってから再投入)
		if (!(await waitUntilReflected(store, intent.id, clock))) {
			throw new Error(
				"EMBED_CONFIRM_TIMEOUT: upsert反映確認がタイムアウト(06 §2・Cronのバックフィルで回収)",
			);
		}
		const db = drizzle(env.DB);
		await db
			.update(intents)
			.set({ embeddingModel: embedder.modelId, embeddedAt: clock.now() })
			.where(eq(intents.id, intent.id));
		// 第2段への再投入(同version・即時・docs/06 §2)
		await emitMatchEvent(env, {
			eventType: "embedding_completed",
			intentId: intent.id,
			version: intent.version,
		});
		logger.info("pipeline.stage1.completed", {
			intent_id: intent.id,
			latency: clock.now().getTime() - startedAt,
		});
		return "embedded";
	} catch (error) {
		logger.warn("pipeline.stage1.failed", {
			error_code: errorCodeOf(error),
			intent_id: intent.id,
		});
		return "failed";
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

/** 起点イベントをfailedへ倒す(Embedding失敗・再試行なし・06 §5)。processedAtは記録しない */
const markFailed = async (env: Env, eventId: string): Promise<void> => {
	await drizzle(env.DB)
		.update(matchEvents)
		.set({ status: "failed" })
		.where(eq(matchEvents.id, eventId));
};

/**
 * 通常キューの1メッセージを処理する(docs/06 §2の処理枝)。
 * 失敗はD1のイベント行statusで記録し、ここでは例外を握って呼び出し側へは
 * 正常復帰する(全メッセージackの設計・06 §5)
 */
const consumeEvent = async (
	env: Env,
	eventId: string,
	clock: Clock,
): Promise<void> => {
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
	// embedding_completed(第2段・docs/06 §2〜§3): 評価実行(Layer 2検索→
	// Layer 1→Layer 3→候補保存)をevaluateIntentへ委譲し、戻り値の計測結果を
	// 起点イベントのpayloadへ記録する(docs/06 §7のイベント単位の計測)。
	// evaluateIntentがnull(抑制・対象外)のときはskippedを載せてprocessedへ倒す
	if (event.eventType === "embedding_completed") {
		const result = await evaluateIntent(env, event.sourceIntentId, clock);
		await markProcessed(
			env,
			event.id,
			clock,
			result === null
				? { skipped: "suppressed" }
				: {
						retrieval_count: result.retrievalCount,
						l1_pass: result.l1Pass,
						l1_exclusions: result.exclusions,
						l3_pass: result.l3Pass,
					},
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
		const result = await runEmbeddingStage(env, current, clock);
		if (result === "failed") {
			// Embedding失敗は再試行しない(06 §5)。Cronのバックフィルが回収する
			await markFailed(env, event.id);
			return;
		}
		await markProcessed(env, event.id, clock);
		return;
	}
	// 第1段の未対応種別(将来追加分)は何もせず保持する(ackのみ)
};

/** 通常キュー(match-events)のバッチを処理する。1メッセージの例外でバッチ全体を倒さない */
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
			await consumeEvent(env, eventId, clock);
		} catch (error) {
			// 個別消費の失敗は再試行せずack(06 §5の設計)。intent_idはこの時点で
			// 特定できないため記録しない(許可フィールドのみ・docs/08 §6)
			logger.warn("pipeline.stage1.failed", { error_code: errorCodeOf(error) });
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
 * Queuesのバッチ消費の入口(index.tsのqueueハンドラから呼ぶ)。
 * キュー名はbatch.queueで判別し、例外を外へ出さない(=全メッセージack)。
 * batch全体のretryは使わない設計で、失敗はイベント行のstatusで記録する(06 §5)
 */
export const handleQueueBatch = async (
	batch: MessageBatch<MatchQueueMessage>,
	env: Env,
	_ctx: ExecutionContext,
	clock: Clock,
): Promise<void> => {
	try {
		if (batch.queue === "match-events-dlq") {
			await handleDlqBatch(env, batch);
			return;
		}
		await handleMainQueueBatch(env, batch, clock);
	} catch (error) {
		// 最終安全網: 例外を外へ出さずackする(失敗はメッセージごとの記録に努める)
		logger.warn("pipeline.stage1.failed", { error_code: errorCodeOf(error) });
	}
};
