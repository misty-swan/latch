/**
 * 直近のベクトルの控え(recent_vectors・#47・設計 2026-10-25 §1.2〜§1.3)の試験。
 * - ベクトルのBLOB化(float32の並び)と復元
 * - 同じintent_idの上書き・意思の削除でのCASCADE・15分を過ぎた行の削除
 * - 第1段の成功の後に控えが書かれ、embedded_atが意思の行と等しい
 * - 書き込みの失敗は例外を外へ出さない(第1段の失敗にしない)
 * - 評価での補い: 控えの読み込み(loadRecentVectorRefs→照会の結果に無いidだけloadRecentVectorValues)と
 *   照会の結果への混ぜ込み(mergeSupplement)
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
import { layer1Judge } from "../src/pipeline/layer1";
import {
	decodeVector,
	deleteExpiredRecentVectors,
	encodeVector,
	loadRecentVectorRefs,
	loadRecentVectorValues,
	mergeSupplement,
	refsMissingFromHits,
	saveRecentVector,
} from "../src/pipeline/recent-vectors";
import { cosineSimilarity } from "../src/vectorstore/similarity";
import { resetVectorState } from "./reset-vector-state";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const clock = fixedClock(new Date("2026-10-25T12:00:00.000Z"));

const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

beforeEach(async () => {
	await resetVectorState();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** 利用者とactiveの意思を1件ずつ投入する(userIdを渡したときはその利用者の意思だけを足す) */
const seedIntent = async (existingUserId?: string): Promise<string> => {
	const userId = existingUserId ?? ulid();
	const intentId = ulid();
	const now = clock.now();
	if (existingUserId === undefined) {
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
	}
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

/** 補いの読み込みへ渡す起点の意思の行 */
const originOf = async (intentId: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, intentId));
	if (row === undefined) {
		throw new Error(`intent not found: ${intentId}`);
	}
	return row;
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

describe("mergeSupplement(照会の結果への補いの混ぜ込み)", () => {
	const own = [1, 0, 0];

	it("照会の結果にあるidは重複させず、supplementedに数えない", () => {
		const hits = [{ id: "A", score: 0.9 }];
		const merged = mergeSupplement(
			hits,
			[{ id: "A", values: [1, 0, 0] }],
			own,
			10,
		);
		expect(merged.hits).toEqual([{ id: "A", score: 0.9 }]);
		expect(merged.supplemented).toBe(0);
	});

	it("補った行は照会と同じコサイン類似度で並び、topKで切られ、残った補いだけを数える", () => {
		const hits = [
			{ id: "H1", score: 0.9 },
			{ id: "H2", score: 0.5 },
			{ id: "H3", score: 0.4 },
		];
		const high = [0.8, 0.6, 0]; // 類似度0.8(上位に入る)
		const low = [0, 1, 0]; // 類似度0(切られる)
		const merged = mergeSupplement(
			hits,
			[
				{ id: "S1", values: high },
				{ id: "S2", values: low },
			],
			own,
			3,
		);
		expect(merged.hits.map((h) => h.id)).toEqual(["H1", "S1", "H2"]);
		expect(merged.hits[1]?.score).toBe(cosineSimilarity(own, high));
		expect(merged.hits[1]?.score).toBeCloseTo(0.8, 10);
		expect(merged.supplemented).toBe(1);
	});

	it("同点はid昇順で並ぶ", () => {
		const merged = mergeSupplement(
			[{ id: "B", score: 1 }],
			[{ id: "A", values: [2, 0, 0] }],
			own,
			10,
		);
		expect(merged.hits.map((h) => h.id)).toEqual(["A", "B"]);
		expect(merged.supplemented).toBe(1);
	});

	it("自分のベクトルと次元の違う行は読み飛ばす", () => {
		const merged = mergeSupplement(
			[],
			[
				{ id: "X", values: [1, 0] },
				{ id: "Y", values: [1, 0, 0] },
			],
			own,
			10,
		);
		expect(merged.hits.map((h) => h.id)).toEqual(["Y"]);
		expect(merged.supplemented).toBe(1);
	});
});

describe("loadRecentVectorRefs・loadRecentVectorValues(控えの読み込み)", () => {
	it("同じform・active・15分以内・自分以外・現在の版の埋め込みを、新しい順にlimit件まで読む", async () => {
		const now = clock.now().getTime();
		const self = await seedIntent();
		const older = await seedIntent();
		const newer = await seedIntent();
		const third = await seedIntent();
		const paused = await seedIntent();
		const occasion = await seedIntent();
		const expired = await seedIntent();
		await db
			.update(intents)
			.set({ status: "paused" })
			.where(eq(intents.id, paused));
		await db
			.update(intents)
			.set({ form: "occasion" })
			.where(eq(intents.id, occasion));
		const at = (offsetMs: number) => new Date(now - offsetMs);
		/** 第1段と同じく、意思の embedded_at と控えを同じ時刻で書く */
		const saveCurrent = async (
			id: string,
			embeddedAt: Date,
			values: number[],
		) => {
			await db.update(intents).set({ embeddedAt }).where(eq(intents.id, id));
			await saveRecentVector(testEnv.DB, id, embeddedAt, values);
		};
		await saveCurrent(self, at(0), sampleVector(0));
		await saveCurrent(older, at(60_000), sampleVector(1));
		await saveCurrent(newer, at(10_000), sampleVector(2));
		await saveCurrent(third, at(120_000), sampleVector(3));
		await saveCurrent(paused, at(0), sampleVector(4));
		await saveCurrent(occasion, at(0), sampleVector(5));
		await saveCurrent(
			expired,
			at(PIPELINE.RECENT_VECTOR_TTL_MS + 1),
			sampleVector(6),
		);
		// ちょうど15分前の行は読む(embedded_at ≥ now − 15分)
		const edge = await seedIntent();
		await saveCurrent(edge, at(PIPELINE.RECENT_VECTOR_TTL_MS), sampleVector(7));

		// 内容を直して埋め込み直す前(intents.embedded_atがnull)・別の時刻で埋め込み直した意思の
		// 控えは現在の版でないので読まない
		const edited = await seedIntent();
		await saveRecentVector(testEnv.DB, edited, at(5_000), sampleVector(8));
		const reembedded = await seedIntent();
		await saveCurrent(reembedded, at(1_000), sampleVector(9));
		await saveRecentVector(testEnv.DB, reembedded, at(2_000), sampleVector(9));

		const refs = await loadRecentVectorRefs(testEnv.DB, {
			origin: await originOf(self),
			now: clock.now(),
			limit: 50,
		});
		expect(refs.map((r) => r.id)).toEqual([newer, older, third, edge]);
		// 1回目はベクトルを読まない(idと時刻だけ)
		expect(Object.keys(refs[0] ?? {}).sort()).toEqual(["embeddedAt", "id"]);
		const all = await loadRecentVectorValues(testEnv.DB, refs);
		expect(all.map((r) => r.id)).toEqual([newer, older, third, edge]);
		expect(all[0]?.values).toEqual(
			Array.from(Float32Array.from(sampleVector(2))),
		);

		const limited = await loadRecentVectorRefs(testEnv.DB, {
			origin: await originOf(self),
			now: clock.now(),
			limit: 2,
		});
		expect(limited.map((r) => r.id)).toEqual([newer, older]);
	});

	it("Layer 1で必ず落ちる相手(同じ利用者・機会Intentの時間の重なり15分未満)を除いて読む(LAT-99)", async () => {
		const now = clock.now().getTime();
		const hour = 60 * 60_000;
		const minute = 60_000;
		const base = now + 24 * hour;
		/** 機会Intentにして時間を決め、控えを現在の版として書く */
		const occasionAt = async (
			id: string,
			window: { startsAt: number | null; endsAt: number | null },
			expiresAt: number,
			embeddedOffsetMs: number,
		) => {
			const embeddedAt = new Date(now - embeddedOffsetMs);
			await db
				.update(intents)
				.set({
					form: "occasion",
					startsAt: window.startsAt === null ? null : new Date(window.startsAt),
					endsAt: window.endsAt === null ? null : new Date(window.endsAt),
					expiresAt: new Date(expiresAt),
					embeddedAt,
				})
				.where(eq(intents.id, id));
			await saveRecentVector(testEnv.DB, id, embeddedAt, sampleVector(1));
		};
		// 起点は base〜base+2時間
		const self = await seedIntent();
		await occasionAt(
			self,
			{ startsAt: base, endsAt: base + 2 * hour },
			base + 3 * hour,
			0,
		);
		const selfRow = await originOf(self);
		// 同じ利用者の別の意思(時間は重なる)→ self_pair で除く
		const sameUser = await seedIntent(selfRow.userId);
		await occasionAt(
			sameUser,
			{ startsAt: base, endsAt: base + 2 * hour },
			base + 3 * hour,
			1_000,
		);
		// 重なり14分 → 除く
		const short = await seedIntent();
		await occasionAt(
			short,
			{ startsAt: base + 2 * hour - 14 * minute, endsAt: base + 4 * hour },
			base + 5 * hour,
			2_000,
		);
		// 重なりちょうど15分 → 残す
		const edge = await seedIntent();
		await occasionAt(
			edge,
			{ startsAt: base + 2 * hour - 15 * minute, endsAt: base + 4 * hour },
			base + 5 * hour,
			3_000,
		);
		// ends_atが無くexpires_atを終端にする: base−1時間〜base+30分で重なり30分 → 残す
		const byExpiry = await seedIntent();
		await occasionAt(
			byExpiry,
			{ startsAt: base - hour, endsAt: null },
			base + 30 * minute,
			4_000,
		);
		// ends_atが無くexpires_atが base+10分で重なり10分 → 除く
		const byExpiryShort = await seedIntent();
		await occasionAt(
			byExpiryShort,
			{ startsAt: base - hour, endsAt: null },
			base + 10 * minute,
			5_000,
		);
		// starts_atが無い(判定できない)→ Layer 1と同じく除かない
		const noStart = await seedIntent();
		await occasionAt(
			noStart,
			{ startsAt: null, endsAt: null },
			base + 5 * hour,
			6_000,
		);
		// 時間が全く重ならない → 除く
		const later = await seedIntent();
		await occasionAt(
			later,
			{ startsAt: base + 5 * hour, endsAt: base + 6 * hour },
			base + 7 * hour,
			7_000,
		);

		const refs = await loadRecentVectorRefs(testEnv.DB, {
			origin: selfRow,
			now: clock.now(),
			limit: 50,
		});
		expect(refs.map((r) => r.id)).toEqual([edge, byExpiry, noStart]);

		// Layer 1の判定と食い違わない(除いた相手はLayer 1でも不合格・残した相手はこの2つの理由では落ちない)
		const birthDates: Record<string, string> = {};
		for (const id of [
			sameUser,
			short,
			edge,
			byExpiry,
			byExpiryShort,
			noStart,
			later,
		]) {
			const row = await originOf(id);
			birthDates[row.userId] = "1990-01-01";
		}
		birthDates[selfRow.userId] = "1990-01-01";
		const reasons = new Map<string, string | undefined>();
		for (const id of [
			sameUser,
			short,
			edge,
			byExpiry,
			byExpiryShort,
			noStart,
			later,
		]) {
			reasons.set(
				id,
				layer1Judge(
					selfRow,
					await originOf(id),
					birthDates,
					false,
					false,
					clock.now(),
				).reason,
			);
		}
		expect(Object.fromEntries(reasons)).toEqual({
			[sameUser]: "self_pair",
			[short]: "time_no_overlap",
			[edge]: undefined,
			[byExpiry]: undefined,
			[byExpiryShort]: "time_no_overlap",
			[noStart]: undefined,
			[later]: "time_no_overlap",
		});
	});

	it("つながりIntentの起点では時間の条件を付けず、同じ利用者だけを除く(LAT-99)", async () => {
		const now = clock.now().getTime();
		const self = await seedIntent();
		const selfRow = await originOf(self);
		const sameUser = await seedIntent(selfRow.userId);
		const other = await seedIntent();
		for (const [id, offset] of [
			[self, 0],
			[sameUser, 1_000],
			[other, 2_000],
		] as const) {
			const embeddedAt = new Date(now - offset);
			await db.update(intents).set({ embeddedAt }).where(eq(intents.id, id));
			await saveRecentVector(testEnv.DB, id, embeddedAt, sampleVector(1));
		}
		const refs = await loadRecentVectorRefs(testEnv.DB, {
			origin: selfRow,
			now: clock.now(),
			limit: 50,
		});
		expect(refs.map((r) => r.id)).toEqual([other]);
	});

	it("loadRecentVectorValuesは1回目の後に上書き・削除された行を返さず、refsの順で返す", async () => {
		const now = clock.now().getTime();
		const a = await seedIntent();
		const b = await seedIntent();
		const c = await seedIntent();
		const at = new Date(now - 10_000);
		await saveRecentVector(testEnv.DB, a, at, sampleVector(1));
		await saveRecentVector(testEnv.DB, b, at, sampleVector(2));
		await saveRecentVector(testEnv.DB, c, at, sampleVector(3));
		// bは1回目の後に埋め込み直された(時刻が変わった)・cは消えた
		await saveRecentVector(testEnv.DB, b, clock.now(), sampleVector(4));
		await db.delete(recentVectors).where(eq(recentVectors.intentId, c));
		const values = await loadRecentVectorValues(testEnv.DB, [
			{ id: c, embeddedAt: at },
			{ id: b, embeddedAt: at },
			{ id: a, embeddedAt: at },
		]);
		expect(values.map((v) => v.id)).toEqual([a]);
	});

	it("loadRecentVectorValuesはrefsが空ならD1を読まない", async () => {
		const throwing = {
			prepare: () => {
				throw new Error("読んではいけない");
			},
		} as unknown as D1Database;
		await expect(loadRecentVectorValues(throwing, [])).resolves.toEqual([]);
	});

	it("refsMissingFromHitsは照会の結果に無い候補だけを順のまま返す", () => {
		const at = clock.now();
		const refs = [
			{ id: "A", embeddedAt: at },
			{ id: "B", embeddedAt: at },
			{ id: "C", embeddedAt: at },
		];
		expect(
			refsMissingFromHits(refs, [{ id: "B" }, { id: "X" }]).map((r) => r.id),
		).toEqual(["A", "C"]);
		expect(
			refsMissingFromHits(refs, [{ id: "A" }, { id: "B" }, { id: "C" }]),
		).toEqual([]);
	});
});
