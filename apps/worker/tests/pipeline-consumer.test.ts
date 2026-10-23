/**
 * Queues消費(第1段)とDLQの統合試験(docs/06 §2・§5)。
 * createMessageBatch+getQueueResult(cloudflare:test)でhandleQueueBatchを直接呼び、
 * D1のmatch_events/intents行とmemoryVectorStoreの実体を検証する。
 * - 第1段: intent_created/intent_updated → Embedding(stub)→ VectorStore upsert →
 *   反映確認 → intents.embedding_model/embedded_at更新 → embedding_completed投入
 *   (同version・即時)→ 起点イベントprocessed
 * - 冪等(processed再消費スキップ)・stale_version破棄・非activeスキップ・
 *   第1段の失敗(段ごとにpendingのままretry・投入だけの失敗は投入だけをやり直す・#17)・DLQのdead反映
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
import { handleQueueBatch, isDlqQueue } from "../src/pipeline/consumer";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	holdMemoryVectorWrites,
	memoryVectorStore,
	releaseMemoryVectorWrites,
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
	releaseMemoryVectorWrites();
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
	vector?: number[],
) => {
	const batch = createMessageBatch<MatchQueueMessage>(
		queueName,
		eventIds.map((eventId, index) => ({
			id: `msg-${index}`,
			timestamp: clock.now(),
			attempts: 1,
			body:
				vector === undefined
					? { event_id: eventId }
					: { event_id: eventId, vector },
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
	it("Embedding→upsert→intents更新→embedding_completed投入(vector付き)→起点processed", async () => {
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
			version: 1,
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
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0]).toHaveLength(1);
		expect(send.mock.calls[0]?.[0]).toEqual({
			event_id: completed[0]?.id,
			vector: expectedValues,
		});
		// 続けて反映確認(vector_reflection・同version)を遅延2秒で投入する
		const reflection = (await eventsOf(intentId)).filter(
			(e) => e.eventType === "vector_reflection",
		);
		expect(reflection).toHaveLength(1);
		expect(reflection[0]?.version).toBe(1);
		expect(reflection[0]?.status).toBe("pending");
		expect(send.mock.calls[1]).toEqual([
			{ event_id: reflection[0]?.id },
			{ delaySeconds: 2 },
		]);

		// 起点イベントはprocessed(payloadに件数等は載せない)
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(origin?.processedAt?.getTime()).toBe(clock.now().getTime());
		expect(origin?.payload).toEqual({});
	});

	it("ストアの反映が遅れていても(hold中)第1段はprocessedになりvector付きで第2段へ渡す", async () => {
		const { intentId, eventId } = await seedEvent();
		const send = spySend();
		holdMemoryVectorWrites();

		expectAcked(await runBatch("match-events", [eventId]));

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		const expectedValues = await stubEmbedding(buildNormalizedText(row));
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ vector: expectedValues });
		// 反映後に読むと、upsertしたmetadataにversion: 1がある
		releaseMemoryVectorWrites();
		const [stored] = await memoryVectorStore().getByIds([intentId]);
		expect(stored?.metadata.version).toBe(1);
	});

	it("embedding_completedはメッセージのvectorで評価し、getByIdsを呼ばない", async () => {
		const { intentId, eventId } = await seedEvent({
			eventType: "embedding_completed",
		});
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		const values = await stubEmbedding(buildNormalizedText(row));
		const getByIds = vi.spyOn(memoryVectorStore(), "getByIds");

		expectAcked(await runBatch("match-events", [eventId], testEnv, values));

		expect(getByIds).not.toHaveBeenCalled();
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(origin?.payload).toHaveProperty("retrieval_count");
	});

	it("vectorの無いembedding_completedは従来どおりgetByIdsで評価する", async () => {
		const { intentId, eventId } = await seedEvent({
			eventType: "embedding_completed",
		});
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		await memoryVectorStore().upsert([
			{
				id: intentId,
				values: await stubEmbedding(buildNormalizedText(row)),
				metadata: {
					form: "connection",
					status: "active",
					category: row.category,
					user_id: row.userId,
				},
			},
		]);
		const getByIds = vi.spyOn(memoryVectorStore(), "getByIds");

		expectAcked(await runBatch("match-events", [eventId]));

		expect(getByIds).toHaveBeenCalled();
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.payload).toHaveProperty("retrieval_count");
	});

	it("空のvectorは渡さず、従来どおりgetByIdsで評価する", async () => {
		const { eventId } = await seedEvent({
			eventType: "embedding_completed",
		});
		const getByIds = vi.spyOn(memoryVectorStore(), "getByIds");

		expectAcked(await runBatch("match-events", [eventId], testEnv, []));

		expect(getByIds).toHaveBeenCalled();
		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		// 自分のベクトルが無いため評価の対象外で終わる
		expect(origin?.payload).toEqual({ skipped: "suppressed" });
	});

	it("古いversionのembedding_completedは評価せずstale_versionでprocessed", async () => {
		// 直した意思(intent=2)に届いた旧version(event=1)の第2段
		const { intentId, eventId } = await seedEvent({
			eventType: "embedding_completed",
			eventVersion: 1,
			intentVersion: 2,
		});
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		const values = await stubEmbedding(buildNormalizedText(row));

		expectAcked(await runBatch("match-events", [eventId], testEnv, values));

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("processed");
		expect(origin?.payload).toEqual({ skipped: "stale_version" });
		// 評価していない(新versionの評価を30分抑制にかけない)
		const [after] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(after?.lastEvaluatedAt).toBeNull();
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

		// embedding_completed・vector_reflectionの投入は1回ずつ(2回目はprocessedスキップ)
		const completed = (await eventsOf(intentId)).filter(
			(e) => e.eventType === "embedding_completed",
		);
		expect(completed).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(2);
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

/**
 * 第1段の1メッセージを指定のattempts(配信の回数)で消費し、結果とretryの呼び出しを返す
 * (retryの遅延秒はgetQueueResultに載らないため、メッセージのretryを見張る)
 */
const runStage1 = async (
	eventId: string,
	targetEnv: WorkerEnv = testEnv,
	attempts = 1,
) => {
	const batch = createMessageBatch<MatchQueueMessage>("match-events", [
		{
			id: "msg-0",
			timestamp: clock.now(),
			attempts,
			body: { event_id: eventId },
		},
	]);
	const [message] = batch.messages;
	const retrySpy = vi.spyOn(message as Message<MatchQueueMessage>, "retry");
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, targetEnv, ctx, clock);
	return { result: await getQueueResult(batch, ctx), retrySpy };
};

/**
 * Workers AIの代わり(LATCH_EMBEDDING_MODE=real)。呼び出しを数え、
 * failがtrueの間は例外にする(Embeddingの段の失敗の再現)
 */
const fakeAiEnv = (state: { fail: boolean }) => {
	const run = vi.fn(async (_model: string, input: { text: string[] }) => {
		if (state.fail) {
			throw new Error("AiError: 3040: Capacity temporarily exceeded");
		}
		return { data: [await stubEmbedding(input.text[0] ?? "")] };
	});
	const aiEnv = {
		...testEnv,
		LATCH_EMBEDDING_MODE: "real",
		AI: { run },
	} as unknown as WorkerEnv;
	return { aiEnv, run };
};

/** SQLの先頭がprefixに一致する問い合わせだけを例外にするD1(他はそのまま通す) */
const failingDb = (prefix: string): D1Database =>
	new Proxy(testEnv.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					if (sql.startsWith(prefix)) {
						throw new Error("D1_ERROR: 試験用の書き込みの失敗");
					}
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

/** 起点のイベント行 */
const originOf = async (eventId: string) => {
	const [origin] = await db
		.select()
		.from(matchEvents)
		.where(eq(matchEvents.id, eventId));
	return origin;
};

describe("第1段の失敗(段ごとの扱い・#17)", () => {
	it("Embeddingの例外: 起点はpendingのまま、配信の回数に応じて10秒・30秒・60秒でretryする", async () => {
		const { intentId, eventId } = await seedEvent();
		spySend();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { aiEnv, run } = fakeAiEnv({ fail: true });

		for (const [attempts, delaySeconds] of [
			[1, 10],
			[2, 30],
			[3, 60],
			[4, 60],
		] as const) {
			const { result, retrySpy } = await runStage1(eventId, aiEnv, attempts);
			expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
			expect(retrySpy).toHaveBeenCalledWith({ delaySeconds });
		}
		expect(run).toHaveBeenCalledTimes(4);

		// 起点はpendingのまま(failedにしない・processedAtも無い)
		const origin = await originOf(eventId);
		expect(origin?.status).toBe("pending");
		expect(origin?.processedAt).toBeNull();
		// intentsは未登録のまま・ベクトルも後続のイベントも無い
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddedAt).toBeNull();
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect((await eventsOf(intentId)).length).toBe(1);
	});

	it("createEmbedderの構築失敗(real+AI無し)も、起点はpendingのままretryする", async () => {
		const { eventId } = await seedEvent();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const brokenEnv = {
			...testEnv,
			LATCH_EMBEDDING_MODE: "real",
			AI: undefined,
		} as unknown as WorkerEnv;

		const { result, retrySpy } = await runStage1(eventId, brokenEnv);

		expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		expect(retrySpy).toHaveBeenCalledWith({ delaySeconds: 10 });
		expect((await originOf(eventId))?.status).toBe("pending");
	});

	it("upsertの例外: 起点はpendingのままretryし、embedded_atを書かない", async () => {
		const { intentId, eventId } = await seedEvent();
		spySend();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(memoryVectorStore(), "upsert").mockRejectedValue(
			new Error("VECTOR_UPSERT_ERROR (code = 40012): x"),
		);

		const { result, retrySpy } = await runStage1(eventId, testEnv, 2);

		expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		expect(retrySpy).toHaveBeenCalledWith({ delaySeconds: 30 });
		expect((await originOf(eventId))?.status).toBe("pending");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddedAt).toBeNull();
		expect((await eventsOf(intentId)).length).toBe(1);
	});

	it("embedded_atの更新の例外: 起点はpendingのままretryし、後続のイベントを投入しない", async () => {
		const { intentId, eventId } = await seedEvent();
		const send = spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const brokenEnv = {
			...testEnv,
			DB: failingDb('update "intents" set "embedding_model"'),
		} as unknown as WorkerEnv;

		const { result, retrySpy } = await runStage1(eventId, brokenEnv, 3);

		expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		expect(retrySpy).toHaveBeenCalledWith({ delaySeconds: 60 });
		expect((await originOf(eventId))?.status).toBe("pending");
		expect(send).not.toHaveBeenCalled();
		expect(logsOf(logSpy, "pipeline.stage1.failed")[0]?.layer).toBe("d1");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddedAt).toBeNull();
	});

	it("投入だけの失敗: ベクトルとembedded_atは書かれてretryし、再配信では埋め込み・upsertをせず投入だけをやり直す", async () => {
		const { intentId, eventId } = await seedEvent();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const state = { fail: false };
		const { aiEnv, run } = fakeAiEnv(state);
		// 1回目の配信: embedding_completedの送信だけが失敗する
		const send = vi
			.spyOn(testEnv.MATCH_QUEUE, "send")
			.mockRejectedValueOnce(new Error("Queue send failed: 一時的な失敗"))
			.mockResolvedValue(sendResponse());
		const upsertSpy = vi.spyOn(memoryVectorStore(), "upsert");

		const first = await runStage1(eventId, aiEnv, 1);

		expect(first.result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		expect(first.retrySpy).toHaveBeenCalledWith({ delaySeconds: 10 });
		expect((await originOf(eventId))?.status).toBe("pending");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddedAt?.getTime()).toBe(clock.now().getTime());
		expect(await memoryVectorStore().getByIds([intentId])).not.toEqual([null]);
		expect(run).toHaveBeenCalledTimes(1);
		expect(upsertSpy).toHaveBeenCalledTimes(1);
		// 送れなかったembedding_completedの行は残さない(残すと再配信で送ったものと見分けられない)
		expect(
			(await eventsOf(intentId)).filter(
				(e) => e.eventType === "embedding_completed",
			),
		).toEqual([]);

		// 2回目の配信: 投入(embedding_completedとvector_reflection)だけを行う
		send.mockClear();
		const second = await runStage1(eventId, aiEnv, 2);

		expect(second.result.retryMessages).toEqual([]);
		expect(run).toHaveBeenCalledTimes(1);
		expect(upsertSpy).toHaveBeenCalledTimes(1);
		const events = await eventsOf(intentId);
		const completed = events.filter(
			(e) => e.eventType === "embedding_completed",
		);
		const reflection = events.filter(
			(e) => e.eventType === "vector_reflection",
		);
		expect(completed).toHaveLength(1);
		expect(reflection).toHaveLength(1);
		// ベクトルは保持していないため、embedding_completedはvector無しで送る
		expect(send.mock.calls).toEqual([
			[{ event_id: completed[0]?.id }],
			[{ event_id: reflection[0]?.id }, { delaySeconds: 2 }],
		]);
		expect((await originOf(eventId))?.status).toBe("processed");
	});

	it("vector_reflectionの投入だけの失敗もretryし、再配信では送れていないvector_reflectionだけを投入する", async () => {
		const { intentId, eventId } = await seedEvent();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { aiEnv, run } = fakeAiEnv({ fail: false });
		// 1回目の配信: embedding_completedは送れ、vector_reflectionの送信だけが失敗する
		const send = vi
			.spyOn(testEnv.MATCH_QUEUE, "send")
			.mockResolvedValueOnce(sendResponse())
			.mockRejectedValueOnce(new Error("Queue send failed: 一時的な失敗"))
			.mockResolvedValue(sendResponse());

		const first = await runStage1(eventId, aiEnv, 1);

		expect(first.retrySpy).toHaveBeenCalledWith({ delaySeconds: 10 });
		expect((await originOf(eventId))?.status).toBe("pending");
		const afterFirst = await eventsOf(intentId);
		expect(
			afterFirst.filter((e) => e.eventType === "embedding_completed"),
		).toHaveLength(1);
		expect(
			afterFirst.filter((e) => e.eventType === "vector_reflection"),
		).toEqual([]);

		// 2回目の配信: vector_reflectionがまた失敗する → 30秒でretry(embedding_completedは送り直さない)
		send.mockClear();
		send.mockRejectedValueOnce(new Error("Queue send failed: 一時的な失敗"));
		const second = await runStage1(eventId, aiEnv, 2);

		expect(second.retrySpy).toHaveBeenCalledWith({ delaySeconds: 30 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[1]).toEqual({ delaySeconds: 2 });
		expect((await originOf(eventId))?.status).toBe("pending");

		// 3回目の配信: vector_reflectionだけを投入して終わる
		send.mockClear();
		const third = await runStage1(eventId, aiEnv, 3);

		expect(third.result.retryMessages).toEqual([]);
		const events = await eventsOf(intentId);
		const reflection = events.filter(
			(e) => e.eventType === "vector_reflection",
		);
		expect(reflection).toHaveLength(1);
		expect(send.mock.calls).toEqual([
			[{ event_id: reflection[0]?.id }, { delaySeconds: 2 }],
		]);
		expect(
			events.filter((e) => e.eventType === "embedding_completed"),
		).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect((await originOf(eventId))?.status).toBe("processed");
	});

	it("投入の再配信の判定: embedded_atが起点の行より前(古い埋め込み)なら埋め込み直す", async () => {
		const { intentId, eventId } = await seedEvent();
		spySend();
		const { aiEnv, run } = fakeAiEnv({ fail: false });
		// 起点の行より前の埋め込み(更新前のversionのもの等)
		await db
			.update(intents)
			.set({ embeddedAt: new Date(clock.now().getTime() - 1_000) })
			.where(eq(intents.id, intentId));

		const { result } = await runStage1(eventId, aiEnv);

		expect(result.retryMessages).toEqual([]);
		expect(run).toHaveBeenCalledTimes(1);
		expect((await originOf(eventId))?.status).toBe("processed");
	});
});

describe("削除の後の書き戻しの防止(第1段・#20・設計 §5.2)", () => {
	/**
	 * Workers AIの代わり(LATCH_EMBEDDING_MODE=real)。埋め込みの計算中(行を読んだ後・
	 * upsertの前)にonEmbedを呼び、stubと同じベクトルを返す
	 */
	const aiEnvWith = (onEmbed: () => Promise<void>): WorkerEnv => {
		const run = vi.fn(async (_model: string, input: { text: string[] }) => {
			await onEmbed();
			return { data: [await stubEmbedding(input.text[0] ?? "")] };
		});
		return {
			...testEnv,
			LATCH_EMBEDDING_MODE: "real",
			AI: { run },
		} as unknown as WorkerEnv;
	};

	it("埋め込みの間に意思が削除されたら、ベクトルを書かず、retryせずに終える", async () => {
		const { intentId, eventId } = await seedEvent();
		const send = spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// 削除APIと同じ順(ベクトル→子の行→意思の行・docs/05 §2.5)
		const aiEnv = aiEnvWith(async () => {
			await memoryVectorStore().deleteByIds([intentId]);
			await db
				.delete(matchEvents)
				.where(eq(matchEvents.sourceIntentId, intentId));
			await db.delete(intents).where(eq(intents.id, intentId));
		});

		const { result, retrySpy } = await runStage1(eventId, aiEnv);

		expect(result.retryMessages).toEqual([]);
		expect(retrySpy).not.toHaveBeenCalled();
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect(send).not.toHaveBeenCalled();
		expect(logsOf(logSpy, "pipeline.stage1.failed")).toEqual([]);
		// 書き戻しの防止が働いた回数を数えられるよう、infoログを1件出す
		expect(logsOf(logSpy, "pipeline.stage1.skipped")).toEqual([
			expect.objectContaining({ intent_id: intentId, layer: "queue" }),
		]);
	});

	it("埋め込みの間に意思がpausedになったら、ベクトルを書かず、起点をprocessedにする", async () => {
		const { intentId, eventId } = await seedEvent();
		const send = spySend();
		const aiEnv = aiEnvWith(async () => {
			await db
				.update(intents)
				.set({ status: "paused" })
				.where(eq(intents.id, intentId));
		});

		const { result, retrySpy } = await runStage1(eventId, aiEnv);

		expect(result.retryMessages).toEqual([]);
		expect(retrySpy).not.toHaveBeenCalled();
		expect(await memoryVectorStore().getByIds([intentId])).toEqual([null]);
		expect(send).not.toHaveBeenCalled();
		expect((await originOf(eventId))?.status).toBe("processed");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(row.embeddedAt).toBeNull();
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

	it("stagingのDLQ(match-events-dlq-staging)のメッセージもstatus=deadへ更新しackする", async () => {
		const { eventId } = await seedEvent();

		const result = await runBatch("match-events-dlq-staging", [eventId]);
		expectAcked(result);

		const [origin] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(origin?.status).toBe("dead");
	});

	it("isDlqQueueは環境ごとのDLQ名だけを真とし、主キューは偽とする", () => {
		expect(isDlqQueue("match-events-dlq")).toBe(true);
		expect(isDlqQueue("match-events-dlq-staging")).toBe(true);
		expect(isDlqQueue("match-events")).toBe(false);
		expect(isDlqQueue("match-events-staging")).toBe(false);
		expect(isDlqQueue("other-dlq")).toBe(false);
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
		// 書いた経路(通常キューはqueue)
		expect(completed[0]?.layer).toBe("queue");
	});

	it("upsertが失敗するとstage1.failedに失敗した段layer=upsertと分類済みerror_codeが載る", async () => {
		const { eventId } = await seedEvent();
		spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(memoryVectorStore(), "upsert").mockRejectedValue(
			new Error("VECTOR_UPSERT_ERROR (code = 40012): x"),
		);

		await runBatch("match-events", [eventId]);

		const failed = logsOf(logSpy, "pipeline.stage1.failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.layer).toBe("upsert");
		expect(failed[0]?.error_code).toBe("VECTOR_UPSERT_40012");
	});

	it("第2段のpayloadは既存の項目の後にF4bの項目を同順で載せる(F4b設計 §5)", async () => {
		const { intentId, eventId } = await seedEvent();
		spySend();
		vi.spyOn(console, "log").mockImplementation(() => {});
		// 第1段でベクトルを作り、発行されたembedding_completedを第2段で消費する
		await runBatch("match-events", [eventId]);
		const [completed] = (await eventsOf(intentId)).filter(
			(e) => e.eventType === "embedding_completed",
		);
		expectAcked(await runBatch("match-events", [completed.id]));

		const [row] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, completed.id));
		expect(row?.status).toBe("processed");
		const payload = row?.payload as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual([
			"retrieval_count",
			"l1_pass",
			"l1_exclusions",
			"l3_pass",
			"l4_skipped_history",
			"jev_calls",
			"jev_reused",
			"jev_held",
			"jev_latency",
			"l5_over_threshold",
			"proposed",
			"held_proposals",
			"l4_skipped_participants",
			"group_pool",
			"group_sets",
			"group_jev_calls",
			"group_held_sets",
			"group_over_threshold",
			"group_proposed",
			"group_held_proposals",
			"group_failed",
			"retrieval_ms",
		]);
		// 相手が居ないためグループの項目はすべて0
		expect(payload).toMatchObject({
			l4_skipped_participants: 0,
			group_pool: 0,
			group_sets: 0,
			group_jev_calls: 0,
			group_held_sets: 0,
			group_over_threshold: 0,
			group_proposed: 0,
			group_held_proposals: 0,
			group_failed: 0,
		});
	});
});
