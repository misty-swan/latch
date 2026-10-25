/**
 * 直近のベクトルの控え(recent_vectors・#47・設計 2026-10-25 §1.2〜§1.3)の試験。
 * - ベクトルのBLOB化(float32の並び)と復元
 * - 同じintent_idの上書き・意思の削除でのCASCADE・15分を過ぎた行の削除
 * - 第1段の成功の後に控えが書かれ、embedded_atが意思の行と等しい
 * - 書き込みの失敗は例外を外へ出さない(第1段の失敗にしない)
 * 時刻はfixedClockで固定し、意思の行は直接投入する。
 */

import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
} from "cloudflare:test";
import { type MatchQueueMessage, PIPELINE } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import { intents, matchEvents, recentVectors, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";
import {
	decodeVector,
	deleteExpiredRecentVectors,
	encodeVector,
	saveRecentVector,
} from "../src/pipeline/recent-vectors";
import { resetMemoryVectorStore } from "../src/vectorstore/memory";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const clock = fixedClock(new Date("2026-10-25T12:00:00.000Z"));

const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

beforeEach(() => {
	resetMemoryVectorStore();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** 利用者とactiveの意思を1件ずつ投入する */
const seedIntent = async (): Promise<string> => {
	const userId = ulid();
	const intentId = ulid();
	const now = clock.now();
	await db.insert(users).values({
		id: userId,
		authProvider: "google",
		authSubject: `recent-vectors-${intentId}`,
		actorType: "individual",
		displayName: "控えの試験",
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
		topic: "控えの試験の学習仲間",
		category: "学び・語学",
		rawText: "控えの試験。一緒に学びましょう。",
		participantsMin: 2,
		participantsMax: 3,
		participantsIncludesOwner: true,
		hardConstraints: [],
		softConstraints: [],
		negativeConstraints: [],
		visibility: "hidden_until_match",
		notificationLevel: "proposals_only",
		alcoholInvolved: false,
		status: "active",
		version: 1,
		createdAt: now,
		updatedAt: now,
	});
	return intentId;
};

const rowsOf = (intentId: string) =>
	db.select().from(recentVectors).where(eq(recentVectors.intentId, intentId));

/** 1,024次元の決まった値(float32で表せない端数を含む) */
const sampleVector = (seed: number): number[] =>
	Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i * 0.37) / 3);

describe("ベクトルのBLOB化", () => {
	it("encodeVector→decodeVectorで1,024次元の値がfloat32の精度で戻る", () => {
		const values = sampleVector(1);
		const encoded = encodeVector(values);
		expect(encoded.byteLength).toBe(1024 * 4);
		const decoded = decodeVector(encoded);
		expect(decoded).toHaveLength(1024);
		expect(decoded).toEqual(Array.from(Float32Array.from(values)));
		// Uint8Array(D1から読んだ形)でも同じ値に戻る
		expect(decodeVector(new Uint8Array(encoded))).toEqual(decoded);
	});
});

describe("saveRecentVector・deleteExpiredRecentVectors", () => {
	it("同じintent_idで2回書くと行は1つで、2回目の値になる", async () => {
		const intentId = await seedIntent();
		const first = new Date(clock.now().getTime() - 60_000);
		await saveRecentVector(testEnv.DB, intentId, first, sampleVector(1));
		await saveRecentVector(testEnv.DB, intentId, clock.now(), sampleVector(2));
		const rows = await rowsOf(intentId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.embeddedAt.getTime()).toBe(clock.now().getTime());
		expect(decodeVector(rows[0]?.vector as Uint8Array)).toEqual(
			Array.from(Float32Array.from(sampleVector(2))),
		);
	});

	it("意思の行を削除すると控えの行も消える(ON DELETE CASCADE)", async () => {
		const intentId = await seedIntent();
		await saveRecentVector(testEnv.DB, intentId, clock.now(), sampleVector(1));
		expect(await rowsOf(intentId)).toHaveLength(1);
		await db.delete(intents).where(eq(intents.id, intentId));
		expect(await rowsOf(intentId)).toHaveLength(0);
	});

	it("書き込みが失敗しても例外を外へ出さない(意思の行が無く外部キーで失敗する)", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			saveRecentVector(testEnv.DB, ulid(), clock.now(), sampleVector(1)),
		).resolves.toBeUndefined();
		const lines = log.mock.calls.map((call) => String(call[0]));
		const failed = lines.find((line) =>
			line.includes("pipeline.recent_vector.failed"),
		);
		expect(failed).toBeDefined();
		expect(JSON.parse(failed as string)).toMatchObject({
			level: "warn",
			error_code: "D1_CONSTRAINT",
		});
	});

	it("埋め込みから15分を過ぎた行だけを消し、消した件数を返す", async () => {
		const now = clock.now().getTime();
		const expiredId = await seedIntent();
		const freshId = await seedIntent();
		await saveRecentVector(
			testEnv.DB,
			expiredId,
			new Date(now - PIPELINE.RECENT_VECTOR_TTL_MS - 1),
			sampleVector(1),
		);
		await saveRecentVector(
			testEnv.DB,
			freshId,
			new Date(now - PIPELINE.RECENT_VECTOR_TTL_MS + 1),
			sampleVector(2),
		);
		expect(PIPELINE.RECENT_VECTOR_TTL_MS).toBe(15 * 60_000);
		expect(await deleteExpiredRecentVectors(testEnv.DB, clock.now())).toBe(1);
		expect(await rowsOf(expiredId)).toHaveLength(0);
		expect(await rowsOf(freshId)).toHaveLength(1);
	});

	it("毎分Cronの保持期間の処理が15分を過ぎた行を消す", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());
		const intentId = await seedIntent();
		await saveRecentVector(
			testEnv.DB,
			intentId,
			new Date(clock.now().getTime() - PIPELINE.RECENT_VECTOR_TTL_MS - 1),
			sampleVector(1),
		);
		await runScheduledPipeline(testEnv, clock);
		expect(await rowsOf(intentId)).toHaveLength(0);
	});
});

describe("第1段での書き込み", () => {
	it("第1段の成功の後に控えの行があり、embedded_atが意思の行と等しい", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());
		const intentId = await seedIntent();
		const eventId = ulid();
		await db.insert(matchEvents).values({
			id: eventId,
			eventType: "intent_created",
			sourceIntentId: intentId,
			version: 1,
			payload: {},
			status: "pending",
			createdAt: clock.now(),
		});
		const batch = createMessageBatch<MatchQueueMessage>("match-events", [
			{
				id: "msg-0",
				timestamp: clock.now(),
				attempts: 1,
				body: { event_id: eventId },
			},
		]);
		const ctx = createExecutionContext();
		await handleQueueBatch(batch, testEnv, ctx, clock);
		const result = await getQueueResult(batch, ctx);
		expect(result.retryMessages).toEqual([]);

		const [intent] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		const rows = await rowsOf(intentId);
		expect(rows).toHaveLength(1);
		expect(intent?.embeddedAt).not.toBeNull();
		expect(rows[0]?.embeddedAt.getTime()).toBe(intent?.embeddedAt?.getTime());
		expect(decodeVector(rows[0]?.vector as Uint8Array)).toHaveLength(1024);
	});
});
