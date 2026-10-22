/**
 * 反映確認のイベント(vector_reflection)の統合試験(不具合の修正工程の設計 §2.3・§2.5)。
 * handleQueueBatchを直接呼び、キューの送信はMATCH_QUEUE.sendのspyで捕まえる。
 * 反映の遅れはインメモリVectorStoreの保留(holdMemoryVectorWrites)で再現する。
 * 時刻はfixedClockで固定し、イベント行のcreated_atをずらして経過を作る。
 */
import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
} from "cloudflare:test";
import type { IntentStatus, MatchQueueMessage } from "@latch/shared";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import { intents, latchMembers, matchEvents, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { stubEmbedding } from "../src/llm/stub/embedding";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	holdMemoryVectorWrites,
	memoryVectorStore,
	releaseMemoryVectorWrites,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

const NOW = new Date("2026-10-22T03:00:00.000Z");
const BASE = NOW.getTime();
const clock = fixedClock(NOW);
const MIN = 60_000;

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/** MATCH_QUEUE.sendを捕捉するモック。実キューへの投入は行わない */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());

type SendSpy = ReturnType<typeof spySend>;

beforeEach(() => {
	resetMemoryVectorStore();
});

afterEach(() => {
	releaseMemoryVectorWrites();
	vi.restoreAllMocks();
});

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-reflection-${id}`,
		actorType: "individual",
		displayName: "反映確認試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
};

/** つながりIntentを1件作る(既定=active・version 1・未評価) */
const insertIntent = async (
	overrides: {
		topic?: string;
		status?: IntentStatus;
		version?: number;
		lastEvaluatedAt?: Date | null;
	} = {},
): Promise<typeof intents.$inferSelect> => {
	const userId = await insertUser();
	const id = ulid();
	await db.insert(intents).values({
		id,
		userId,
		form: "connection",
		topic: overrides.topic ?? "反映確認の学習仲間",
		category: null,
		rawText: "反映確認の試験。一緒に学びましょう。",
		participantsMin: 2,
		participantsMax: 2,
		participantsIncludesOwner: true,
		hardConstraints: [],
		softConstraints: [],
		negativeConstraints: [],
		visibility: "hidden_until_match",
		notificationLevel: "proposals_only",
		alcoholInvolved: false,
		status: overrides.status ?? "active",
		version: overrides.version ?? 1,
		expiresAt: new Date(BASE + 30 * 24 * 60 * MIN),
		lastEvaluatedAt: overrides.lastEvaluatedAt ?? null,
		createdAt: NOW,
		updatedAt: NOW,
	});
	const [row] = await db.select().from(intents).where(eq(intents.id, id));
	if (row === undefined) {
		throw new Error("intentsの行が作れない");
	}
	return row;
};

/** 第1段相当のベクトルをストアへ直接書く(metadataのversionを指定できる・nullは書かない) */
const upsertVector = async (
	row: typeof intents.$inferSelect,
	version: number | null = row.version,
) => {
	await memoryVectorStore().upsert([
		{
			id: row.id,
			values: await stubEmbedding(buildNormalizedText(row)),
			metadata: {
				form: "connection",
				status: "active",
				category: null,
				user_id: row.userId,
				...(version === null ? {} : { version }),
			},
		},
	]);
};

/** イベント行を直接INSERTする */
const seedEvent = async (
	intentId: string,
	eventType: "intent_created" | "vector_reflection",
	version = 1,
	createdAt = NOW,
): Promise<string> => {
	const id = ulid();
	await db.insert(matchEvents).values({
		id,
		eventType,
		sourceIntentId: intentId,
		version,
		payload: {},
		status: "pending",
		createdAt,
	});
	return id;
};

/** handleQueueBatchを直接呼ぶ(メッセージ本体をそのまま渡す) */
const runBodies = async (bodies: MatchQueueMessage[]) => {
	const batch = createMessageBatch<MatchQueueMessage>(
		"match-events",
		bodies.map((body, index) => ({
			id: `msg-${index}`,
			timestamp: NOW,
			attempts: 1,
			body,
		})),
	);
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, testEnv, ctx, clock);
	const result = await getQueueResult(batch, ctx);
	expect(result.outcome).toBe("ok");
	expect(result.retryMessages).toEqual([]);
};

const runEvents = (eventIds: string[]) =>
	runBodies(eventIds.map((event_id) => ({ event_id })));

const eventRow = async (id: string) => {
	const [row] = await db
		.select()
		.from(matchEvents)
		.where(eq(matchEvents.id, id));
	return row;
};

const intentRow = async (id: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, id));
	return row;
};

/** 指定イベント種別の行(起点Intentごと) */
const eventsOfType = async (intentIds: string[], eventType: string) =>
	(
		await db
			.select()
			.from(matchEvents)
			.where(inArray(matchEvents.sourceIntentId, intentIds))
	).filter((e) => e.eventType === eventType);

/** 2人がともに参加しているLATCHの数 */
const sharedLatchCount = async (userA: string, userB: string) => {
	const rows = await db
		.select()
		.from(latchMembers)
		.where(inArray(latchMembers.userId, [userA, userB]));
	const byLatch = new Map<string, Set<string>>();
	for (const r of rows) {
		const set = byLatch.get(r.latchId) ?? new Set<string>();
		set.add(r.userId);
		byLatch.set(r.latchId, set);
	}
	return [...byLatch.values()].filter((s) => s.size === 2).length;
};

/** spyに捕まった送信を、遅延の有無で分けて返す */
const sentBodies = (send: SendSpy) => {
	const immediate: MatchQueueMessage[] = [];
	const delayed: { body: MatchQueueMessage; delaySeconds?: number }[] = [];
	for (const call of send.mock.calls) {
		const body = call[0] as MatchQueueMessage;
		const opts = call[1] as { delaySeconds?: number } | undefined;
		if (opts === undefined) {
			immediate.push(body);
		} else {
			delayed.push({ body, delaySeconds: opts.delaySeconds });
		}
	}
	return { immediate, delayed };
};

describe("第1段からの投入", () => {
	it("第1段はvector_reflectionを遅延2秒で投入する", async () => {
		const intent = await insertIntent();
		const created = await seedEvent(intent.id, "intent_created");
		const send = spySend();

		await runEvents([created]);

		const [reflection] = await eventsOfType([intent.id], "vector_reflection");
		expect(reflection?.version).toBe(1);
		expect(reflection?.status).toBe("pending");
		expect(send).toHaveBeenCalledWith(
			{ event_id: reflection?.id },
			{ delaySeconds: 2 },
		);
	});
});

describe("vector_reflectionの消費", () => {
	it("未反映なら同じevent_idを次の遅延で送り直し、行はpendingのまま", async () => {
		const intent = await insertIntent();
		const eventId = await seedEvent(
			intent.id,
			"vector_reflection",
			1,
			new Date(BASE - 3_000),
		);
		const send = spySend();

		await runEvents([eventId]);

		// 作成から3秒→次の確認は6秒の時点=3秒後
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			{ event_id: eventId },
			{ delaySeconds: 3 },
		);
		expect((await eventRow(eventId))?.status).toBe("pending");
		expect((await intentRow(intent.id))?.lastEvaluatedAt).toBeNull();
	});

	it("作成から5分を過ぎて未反映ならfailed", async () => {
		const intent = await insertIntent();
		const eventId = await seedEvent(
			intent.id,
			"vector_reflection",
			1,
			new Date(BASE - 5 * MIN),
		);
		const send = spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runEvents([eventId]);

		expect(send).not.toHaveBeenCalled();
		expect((await eventRow(eventId))?.status).toBe("failed");
		const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "pipeline.reflection.timeout",
				error_code: "REFLECTION_TIMEOUT",
				intent_id: intent.id,
			}),
		);
	});

	it("metadataのversionが古いベクトルは未反映とみなす", async () => {
		const intent = await insertIntent({ version: 2 });
		await upsertVector(intent, 1);
		const eventId = await seedEvent(intent.id, "vector_reflection", 2);
		const send = spySend();

		await runEvents([eventId]);

		expect(send).toHaveBeenCalledWith(
			{ event_id: eventId },
			{ delaySeconds: 2 },
		);
		expect((await eventRow(eventId))?.status).toBe("pending");
		expect((await intentRow(intent.id))?.lastEvaluatedAt).toBeNull();
	});

	it("metadataにversionが無いベクトルも未反映とみなす", async () => {
		const intent = await insertIntent();
		await upsertVector(intent, null);
		const eventId = await seedEvent(intent.id, "vector_reflection", 1);
		const send = spySend();

		await runEvents([eventId]);

		expect(send).toHaveBeenCalledTimes(1);
		expect((await eventRow(eventId))?.status).toBe("pending");
	});

	it("versionが進んでいればstale_versionでprocessed・評価しない", async () => {
		const intent = await insertIntent({ version: 2 });
		await upsertVector(intent, 1);
		const eventId = await seedEvent(intent.id, "vector_reflection", 1);
		const send = spySend();

		await runEvents([eventId]);

		expect(send).not.toHaveBeenCalled();
		const row = await eventRow(eventId);
		expect(row?.status).toBe("processed");
		expect(row?.payload).toEqual({ skipped: "stale_version" });
		expect((await intentRow(intent.id))?.lastEvaluatedAt).toBeNull();
	});

	it.each(["paused", "expired"] as const)(
		"%sならskippedでprocessed・評価しない",
		async (status) => {
			const intent = await insertIntent({ status });
			await upsertVector(intent);
			const eventId = await seedEvent(intent.id, "vector_reflection", 1);
			const send = spySend();

			await runEvents([eventId]);

			expect(send).not.toHaveBeenCalled();
			const row = await eventRow(eventId);
			expect(row?.status).toBe("processed");
			expect(row?.payload).toEqual({ skipped: "inactive" });
			expect((await intentRow(intent.id))?.lastEvaluatedAt).toBeNull();
		},
	);

	it("反映済みなら30分抑制の内側でも1回評価し、payloadにreflect_msと第2段の項目が載る", async () => {
		const origin = await insertIntent({
			lastEvaluatedAt: new Date(BASE - MIN),
		});
		const partner = await insertIntent({ topic: "反映確認の相手の学習仲間" });
		await upsertVector(origin);
		await upsertVector(partner);
		const eventId = await seedEvent(
			origin.id,
			"vector_reflection",
			1,
			new Date(BASE - 5_000),
		);
		spySend();

		await runEvents([eventId]);

		const row = await eventRow(eventId);
		expect(row?.status).toBe("processed");
		expect(row?.processedAt).toEqual(NOW);
		expect(row?.payload).toMatchObject({
			retrieval_count: 2,
			l1_pass: 1,
			proposed: 1,
			retrieval_ms: expect.any(Number),
			reflect_ms: 5_000,
		});
		expect((await intentRow(origin.id))?.lastEvaluatedAt).toEqual(NOW);
		expect(await sharedLatchCount(origin.userId, partner.userId)).toBe(1);
	});

	it("処理済みの反映確認を再消費しても評価し直さない", async () => {
		const origin = await insertIntent();
		const partner = await insertIntent({ topic: "再消費の相手の学習仲間" });
		await upsertVector(origin);
		await upsertVector(partner);
		const eventId = await seedEvent(origin.id, "vector_reflection", 1);
		spySend();

		await runEvents([eventId]);
		const first = await eventRow(eventId);
		await runEvents([eventId]);

		expect(await eventRow(eventId)).toEqual(first);
		expect(await sharedLatchCount(origin.userId, partner.userId)).toBe(1);
	});
});

describe("同時に預けた2件(#7)", () => {
	/** 2件の第1段→第2段を回し、反映確認のメッセージを返す */
	const runStages = async (send: SendSpy, a: string, b: string) => {
		const createdA = await seedEvent(a, "intent_created");
		const createdB = await seedEvent(b, "intent_created");
		await runEvents([createdA, createdB]);
		const stage1 = sentBodies(send);
		// 第1段は2件とも即時のembedding_completed(vector付き)と遅延2秒の反映確認を投入する
		expect(stage1.immediate).toHaveLength(2);
		expect(stage1.delayed).toHaveLength(2);
		expect(stage1.delayed.every((d) => d.delaySeconds === 2)).toBe(true);
		for (const body of stage1.immediate) {
			expect(body.vector?.length).toBeGreaterThan(0);
		}
		await runBodies(stage1.immediate);
		return stage1.delayed.map((d) => d.body);
	};

	it("hold中に両方の第1段・第2段を回すと提案は無く、release後に反映確認を回すと2人の提案が1件できる", async () => {
		const a = await insertIntent({ topic: "同時に預けた学習仲間A" });
		const b = await insertIntent({ topic: "同時に預けた学習仲間B" });
		const send = spySend();
		holdMemoryVectorWrites();

		const reflections = await runStages(send, a.id, b.id);

		// 第2段の時点では互いのベクトルが見えず、提案は無い
		expect(await sharedLatchCount(a.userId, b.userId)).toBe(0);
		const completed = await eventsOfType([a.id, b.id], "embedding_completed");
		expect(completed).toHaveLength(2);
		for (const e of completed) {
			expect(e.status).toBe("processed");
			expect(e.payload).toMatchObject({ proposed: 0 });
		}

		releaseMemoryVectorWrites();
		await runBodies(reflections);

		expect(await sharedLatchCount(a.userId, b.userId)).toBe(1);
		const done = await eventsOfType([a.id, b.id], "vector_reflection");
		expect(done).toHaveLength(2);
		for (const e of done) {
			expect(e.status).toBe("processed");
			expect(e.payload).toHaveProperty("reflect_ms", 0);
		}
		const proposedTotal = done.reduce(
			(sum, e) => sum + Number((e.payload as { proposed: number }).proposed),
			0,
		);
		expect(proposedTotal).toBe(1);
	});

	it("即時の評価で提案済みの組は、評価し直しで二重に提案されない", async () => {
		const a = await insertIntent({ topic: "即時に見えた学習仲間A" });
		const b = await insertIntent({ topic: "即時に見えた学習仲間B" });
		const send = spySend();

		const reflections = await runStages(send, a.id, b.id);
		expect(await sharedLatchCount(a.userId, b.userId)).toBe(1);

		await runBodies(reflections);

		expect(await sharedLatchCount(a.userId, b.userId)).toBe(1);
		const done = await eventsOfType([a.id, b.id], "vector_reflection");
		for (const e of done) {
			expect(e.status).toBe("processed");
			expect(e.payload).toMatchObject({ proposed: 0 });
		}
	});
});
