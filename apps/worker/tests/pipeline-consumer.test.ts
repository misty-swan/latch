/**
 * Queues消費(第1段)とDLQの統合試験(docs/06 §2・§5)。
 * createMessageBatch+getQueueResult(cloudflare:test)でhandleQueueBatchを直接呼び、
 * D1のmatch_events/intents行とmemoryVectorStoreの実体を検証する。
 * - 第1段: intent_created/intent_updated → Embedding(stub)→ VectorStore upsert →
 *   反映確認 → intents.embedding_model/embedded_at更新 → embedding_completed投入
 *   (同version・即時)→ 起点イベントprocessed
 * - 冪等(processed再消費スキップ)・stale_version破棄・非activeスキップ・
 *   Embedding失敗(status=failed・再試行なし・バッチはack)・DLQのdead反映
 * 時刻はfixedClockで固定。ベクトル格納先はlocalのインメモリ実装
 * (wrangler varsのLATCH_ENV=local・vectorstore/index.ts)。
 * 消費対象の行はusers/intents/match_eventsを直接投入して作る
 * (バージョンやstatusを試験ごとに制御するため)。
 */

import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
} from "cloudflare:test";
import {
	type Category,
	EMBEDDING_MODEL_STUB,
	type IntentStatus,
	type MatchEventType,
	type MatchQueueMessage,
} from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import { intents, matchEvents, users } from "../src/db/schema";
// ルート・handleQueueBatchが受け取るEnv(src/env.ts・生成型Envの宣言部分型)
import type { Env as WorkerEnv } from "../src/env";
import { stubEmbedding } from "../src/llm/stub/embedding";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	memoryVectorStore,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 試験全体で固定する現在時刻(docs/04 §4のfixedClock) */
const clock = fixedClock(new Date("2026-10-19T12:00:00.000Z"));

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状・pipeline-events.test.tsと同一) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/** MATCH_QUEUE.sendを捕捉するモック。実キューへの投入は行わない */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());

beforeEach(() => {
	// テスト間のベクトル汚染除去(シングルトンのインメモリ実装のため)
	resetMemoryVectorStore();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** 消費対象の準備( users/intents/match_eventsを直接投入) */
const seedEvent = async (
	overrides: {
		eventType?: MatchEventType;
		eventStatus?: "pending" | "processed" | "failed" | "dead";
		eventVersion?: number;
		intentStatus?: IntentStatus;
		intentVersion?: number;
		category?: Category;
	} = {},
): Promise<{ userId: string; intentId: string; eventId: string }> => {
	const userId = ulid();
	const intentId = ulid();
	const eventId = ulid();
	const now = clock.now();
	await db.insert(users).values({
		id: userId,
		authProvider: "google",
		authSubject: `pipeline-consumer-${eventId}`,
		actorType: "individual",
		displayName: "消費試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(intents).values({
		id: intentId,
		userId,
		form: "connection",
		topic: "消費試験の学習仲間",
		category: overrides.category ?? "学び・語学",
		rawText: "消費試験。一緒に学びましょう。",
		participantsMin: 2,
		participantsMax: 3,
		participantsIncludesOwner: true,
		hardConstraints: [],
		softConstraints: [],
		negativeConstraints: [],
		visibility: "hidden_until_match",
		notificationLevel: "proposals_only",
		alcoholInvolved: false,
		status: overrides.intentStatus ?? "active",
		version: overrides.intentVersion ?? 1,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(matchEvents).values({
		id: eventId,
		eventType: overrides.eventType ?? "intent_created",
		sourceIntentId: intentId,
		version: overrides.eventVersion ?? 1,
		payload: {},
		status: overrides.eventStatus ?? "pending",
		createdAt: now,
	});
	return { userId, intentId, eventId };
};

/**
 * handleQueueBatchを直接呼んで結果(ack/retry状態)を返す。
 * バッチは指定キュー名で作り、メッセージ本体は{event_id}(sharedのMatchQueueMessage)
 */
const runBatch = async (
	queueName: string,
	eventIds: string[],
	targetEnv: WorkerEnv = testEnv,
) => {
	const batch = createMessageBatch<MatchQueueMessage>(
		queueName,
		eventIds.map((eventId, index) => ({
			id: `msg-${index}`,
			timestamp: clock.now(),
			attempts: 1,
			body: { event_id: eventId },
		})),
	);
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, targetEnv, ctx, clock);
	return getQueueResult(batch, ctx);
};

/** 消費結果が「再試行なし=ack」であることを検査する(docs/06 §5の設計: 失敗もack) */
const expectAcked = (
	result: Awaited<ReturnType<typeof getQueueResult>>,
): void => {
	expect(result.outcome).toBe("ok");
	expect(result.retryBatch.retry).toBe(false);
	expect(result.retryMessages).toEqual([]);
};

/** 指定Intentのイベント行一覧 */
const eventsOf = (
	intentId: string,
): Promise<(typeof matchEvents.$inferSelect)[]> =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

describe("第1段の消費(intent_created・docs/06 §2)", () => {
	it("Embedding→upsert→反映確認→intents更新→embedding_completed投入→起点processed", async () => {
		const { userId, intentId, eventId } = await seedEvent();
		const send = spySend();

		const result = await runBatch("match-events", [eventId]);

		// バッチはack(再試行なし)
		expectAcked(result);

		// ベクトルがmemoryVectorStoreへupsertされている(id=Intent ULID・docs/05 §2.3)
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		const expectedValues = await stubEmbedding(buildNormalizedText(row));
		const [vector] = await memoryVectorStore().getByIds([intentId]);
		expect(vector).not.toBeNull();
		expect(vector?.values).toEqual(expectedValues);
		expect(vector?.metadata).toEqual({
			form: "connection",
			status: "active",
			category: "学び・語学",
			user_id: userId,
		});

		// intents.embedding_model/embedded_atが更新されている(stub・fixedClock時刻)
		expect(row.embeddingModel).toBe(EMBEDDING_MODEL_STUB);
		expect(row.embeddedAt?.getTime()).toBe(clock.now().getTime());

		// embedding_completedイベントが同versionで投入されstatus=pending
		const completed = (await eventsOf(intentId)).filter(
			(e) => e.eventType === "embedding_completed",
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.version).toBe(1);
		expect(completed[0]?.status).toBe("pending");

		// embedding_completedは即時投入(delaySeconds未指定=第2引数なしのsend)
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toHaveLength(1);
		expect(send.mock.calls[0]?.[0]).toEqual({ event_id: completed[0]?.id });

		// 起点イベントはprocessed(payloadに件数等は載せない)
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(origin?.processedAt?.getTime()).toBe(clock.now().getTime());
		expect(origin?.payload).toEqual({});
	});

	it("embedding_completedイベントは第2段の評価へ委譲されprocessedになる", async () => {
		const { intentId, eventId } = await seedEvent({
			eventType: "embedding_completed",
		});

		const result = await runBatch("match-events", [eventId]);

		// ベクトルが無い(第1段を経ていない)ため評価は対象外パスで終わり、
		// 呼び出し側はnullを受けてskippedをpayloadへ載せてprocessedにする
		expectAcked(result);
		const [row] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(row?.status).toBe("processed");
		expect(row?.payload).toEqual({ skipped: "suppressed" });
		// 第1段の副作用も起きない
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
	});
});

describe("冪等とスキップ条件(docs/06 §2)", () => {
	it("二重消費(同一event_idの再消費)は2回目は何もしない", async () => {
		const { intentId, eventId } = await seedEvent();
		const send = spySend();

		const first = await runBatch("match-events", [eventId]);
		expectAcked(first);
		const second = await runBatch("match-events", [eventId]);
		expectAcked(second);

		// embedding_completedの投入は1回だけ(2回目はprocessedスキップ)
		const completed = (await eventsOf(intentId)).filter(
			(e) => e.eventType === "embedding_completed",
		);
		expect(completed).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("event.versionがintent.versionと不一致ならstale_versionでprocessed・埋め込みはしない", async () => {
		// 更新の10秒遅延配信の間に次の更新が来た状態(event=2・intent=1)
		const { intentId, eventId } = await seedEvent({
			eventType: "intent_updated",
			eventVersion: 2,
			intentVersion: 1,
		});

		const result = await runBatch("match-events", [eventId]);
		expectAcked(result);

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(origin?.payload).toEqual({ skipped: "stale_version" });
		// 埋め込み系の副作用は無し
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect((await eventsOf(intentId)).length).toBe(1);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddingModel).toBeNull();
	});

	it("intent.statusがactive以外(paused)ならprocessedでスキップする", async () => {
		const { intentId, eventId } = await seedEvent({
			intentStatus: "paused",
		});

		const result = await runBatch("match-events", [eventId]);
		expectAcked(result);

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect((await eventsOf(intentId)).length).toBe(1);
	});

	it("event行が存在しないメッセージは何もせずackする(送信先行の先着・Task 6引継ぎ)", async () => {
		// D1に存在しないevent_id(ULID)をbodyに持つメッセージだけのバッチ
		const missingEventId = ulid();

		const result = await runBatch("match-events", [missingEventId]);
		expectAcked(result);

		// 副作用は無い(ベクトルもイベント行も増えない)
		const rows = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, missingEventId));
		expect(rows).toHaveLength(0);
		expect(await memoryVectorStore().getByIds([missingEventId])).toEqual([
			null,
		]);
	});
});

describe("Embedding失敗(docs/06 §5: 再試行なし・バックフィル回収)", () => {
	it("createEmbedderの構築失敗(real+AI無し)で起点イベントはfailed・バッチはack", async () => {
		const { intentId, eventId } = await seedEvent();
		// LATCH_EMBEDDING_MODE=real+AIバインディング無しのenvを部分上書きで構築
		// (createEmbedderが構築時にthrowする状態・llm/embedding.ts)
		const brokenEnv = {
			...testEnv,
			LATCH_EMBEDDING_MODE: "real",
			AI: undefined,
		} as unknown as WorkerEnv;

		const result = await runBatch("match-events", [eventId], brokenEnv);

		// 失敗でも再試行させずack(06 §5: Embedding失敗は再試行なし・Cronのバックフィルで回収)
		expectAcked(result);

		// 起点イベントはfailed(processedAtは記録しない)
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("failed");
		expect(origin?.processedAt).toBeNull();

		// intentsは未登録のまま・ベクトルもembedding_completedも無い
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddingModel).toBeNull();
		expect(row.embeddedAt).toBeNull();
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect((await eventsOf(intentId)).length).toBe(1);
	});
});

describe("DLQの消費(docs/06 §5: dead反映と警報)", () => {
	it("match-events-dlqのメッセージはイベント行をstatus=deadへ更新しackする", async () => {
		const { eventId } = await seedEvent();

		const result = await runBatch("match-events-dlq", [eventId]);
		expectAcked(result);

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("dead");
	});
});

/** console.logへ出た構造化ログ(JSON1行)のうち、指定eventのものを返す */
const logsOf = (
	spy: ReturnType<typeof vi.spyOn>,
	event: string,
): Record<string, unknown>[] =>
	spy.mock.calls
		.map(
			(call: unknown[]) =>
				JSON.parse(String(call[0])) as Record<string, unknown>,
		)
		.filter((line: Record<string, unknown>) => line.event === event);

describe("ログの分離と計測(docs/06 §7・docs/08 §6)", () => {
	it("第2段のevaluateIntentが例外ならstage2.failedを出し(stage1.failedは出さず)起点はfailed", async () => {
		const { intentId, eventId } = await seedEvent({
			eventType: "embedding_completed",
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// local以外でVECTORSが無いとcreateVectorStore経由のgetByIdsで例外になる
		const brokenEnv = {
			...testEnv,
			LATCH_ENV: "staging",
			VECTORS: undefined,
		} as unknown as WorkerEnv;

		const result = await runBatch("match-events", [eventId], brokenEnv);

		expectAcked(result);
		expect(logsOf(logSpy, "pipeline.stage2.failed")).toHaveLength(1);
		expect(logsOf(logSpy, "pipeline.stage2.failed")[0]?.intent_id).toBe(
			intentId,
		);
		expect(logsOf(logSpy, "pipeline.stage1.failed")).toHaveLength(0);
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("failed");
	});

	it("stage1.completedログにcountが載る", async () => {
		const { eventId } = await seedEvent();
		spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runBatch("match-events", [eventId]);

		const completed = logsOf(logSpy, "pipeline.stage1.completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]?.count).toBe(1);
	});
});
