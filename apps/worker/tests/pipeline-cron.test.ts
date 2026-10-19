/**
 * 毎分Cron(runScheduledPipeline)の統合試験(docs/06 §2・docs/05 §2.6・docs/12 Task 12)。
 * runScheduledPipelineをfixedClockで直接呼ぶパターンで各走査の選択条件と境界
 * (2時間ちょうど・30分ちょうど・10分ちょうど・5分猶予)を検証し、加えて
 * index.tsのscheduledハンドラへの結線をcreateScheduledControllerで1回呼って
 * 確認する。行は直接INSERTし、ベクトルはmemoryVectorStoreへ直接upsertする
 * (pipeline-evaluate.test.tsの直接呼び出しパターンと同一)。
 * 埋め込みはstub(LATCH_EMBEDDING_MODE=stub)で実走し、MATCH_QUEUE.sendは
 * モックする(TEST_QUEUES_DISABLED環境のため消費は起きない)。
 */

import {
	createExecutionContext,
	createScheduledController,
	env,
} from "cloudflare:test";
import { PIPELINE } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import {
	groupCandidates,
	intents,
	matchCandidates,
	matchEvents,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import worker from "../src/index";
import { MS_PER_DAY } from "../src/intents/expiry";
import { stubEmbedding } from "../src/llm/stub/embedding";
import { runScheduledPipeline } from "../src/pipeline/cron";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	memoryVectorStore,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";
import type { StoredVector } from "../src/vectorstore/types";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 直接呼び出しパターンで固定する現在時刻(docs/04 §4のfixedClock)。JSTでは2026-06-01 09:00 */
const FIXED_NOW = new Date("2026-06-01T00:00:00Z");
const BASE = FIXED_NOW.getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const directClock = fixedClock(FIXED_NOW);

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状・pipeline-evaluate.test.tsと同一) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/** MATCH_QUEUE.sendを捕捉するモック。実キューへの投入は行わない */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());

/** 直接INSERT用: users行を1件投入する */
const insertUserRow = async (id: string, birthDate = "1990-01-01") => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-cron-${id}`,
		actorType: "individual",
		displayName: "Cron試験",
		bio: "",
		birthDate,
		status: "active",
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
	});
};

/**
 * intents行の完全なフィクスチャ(既定=つながり・地理なし・active・version=1)。
 * 指定のない欄は最小構成の値で埋める(pipeline-evaluate.test.tsと同一方針)
 */
const intentFixture = (
	overrides: Partial<typeof intents.$inferSelect> &
		Pick<typeof intents.$inferSelect, "id" | "userId">,
): typeof intents.$inferSelect => ({
	form: "connection",
	topic: "Cron試験の学習仲間",
	category: null,
	rawText: "Cron試験用の入力文",
	startsAt: null,
	endsAt: null,
	geoCenterLat: null,
	geoCenterLng: null,
	geoRadiusM: null,
	participantsMin: 2,
	participantsMax: 3,
	participantsIncludesOwner: true,
	budgetMin: null,
	budgetMax: null,
	currency: null,
	hardConstraints: [],
	softConstraints: [],
	negativeConstraints: [],
	visibility: "hidden_until_match",
	notificationLevel: "proposals_only",
	alcoholInvolved: false,
	status: "active",
	version: 1,
	expiresAt: new Date(BASE + 30 * MS_PER_DAY),
	embeddingModel: null,
	embeddedAt: null,
	lastEvaluatedAt: null,
	vectorDeletedAt: null,
	delayedReevalAt: null,
	createdAt: FIXED_NOW,
	updatedAt: FIXED_NOW,
	...overrides,
});

/** intents行を直接INSERTする */
const insertIntentRow = async (row: typeof intents.$inferSelect) => {
	await db.insert(intents).values(row);
};

/** 指定Intentのintents行を取得する */
const rowOf = async (intentId: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, intentId));
	return row;
};

/** 正規化テキスト由来のstubベクトルを作る(第1段のupsert相当・metadata上書き可) */
const vectorFor = async (
	row: typeof intents.$inferSelect,
	metadataOverrides: Partial<StoredVector["metadata"]> = {},
): Promise<StoredVector> => ({
	id: row.id,
	values: await stubEmbedding(buildNormalizedText(row)),
	metadata: {
		form: row.form as string,
		status: "active",
		category: row.category ?? null,
		user_id: row.userId,
		...metadataOverrides,
	},
});

/** 正規化テキスト由来のstubベクトルをmemory storeへ直接upsertする(第1段相当) */
const upsertVector = async (
	row: typeof intents.$inferSelect,
	metadataOverrides: Partial<StoredVector["metadata"]> = {},
) => {
	await memoryVectorStore().upsert([await vectorFor(row, metadataOverrides)]);
};

/** 指定Intentのベクトルを取得する(欠損はnull) */
const vectorOf = async (intentId: string) => {
	const [vector] = await memoryVectorStore().getByIds([intentId]);
	return vector ?? null;
};

/**
 * 1対1候補行を直接INSERTする。ペアはa<bへ正規化する(docs/05 §2.2)。
 * formは試験内で共通のつながりとし、versionはUNIQUE(a,b,va,vb)が重複しない範囲で
 * 指定できる
 */
const insertCandidate = async (
	idA: string,
	idB: string,
	status: "candidate" | "proposed",
	updatedAt: Date = FIXED_NOW,
	versions: { a: number; b: number } = { a: 1, b: 1 },
): Promise<void> => {
	const [intentAId, intentBId] = idA < idB ? [idA, idB] : [idB, idA];
	const flip = idA >= idB;
	await db.insert(matchCandidates).values({
		id: ulid(),
		intentAId,
		intentBId,
		intentAVersion: flip ? versions.b : versions.a,
		intentBVersion: flip ? versions.a : versions.b,
		form: "connection",
		status,
		createdAt: FIXED_NOW,
		updatedAt,
	});
};

/** 指定ペア(intent_a・intent_b)の1対1候補行を取得する */
const candidateOfPair = async (idA: string, idB: string) => {
	const [intentAId, intentBId] = idA < idB ? [idA, idB] : [idB, idA];
	const rows = await db
		.select()
		.from(matchCandidates)
		.where(eq(matchCandidates.intentAId, intentAId));
	return rows.filter((row) => row.intentBId === intentBId);
};

/** group_candidates行を直接INSERTする */
const insertGroupCandidate = async (
	intentIds: string[],
	createdAt: Date,
): Promise<void> => {
	await db.insert(groupCandidates).values({
		id: ulid(),
		intentIds,
		dedupKey: `pipeline-cron-${ulid()}`,
		aggregateScore: 0.5,
		status: "candidate",
		createdAt,
	});
};

beforeEach(async () => {
	// テスト間の行の残存を排除する(このテスト環境ではテストごとのD1ロールバックが
	// 行われないため、自前で掃除して各試験を順序非依存にする)。
	// FK参照の順序に従い子→親の順で削除する
	await db.delete(matchEvents);
	await db.delete(matchCandidates);
	await db.delete(groupCandidates);
	await db.delete(intents);
	await db.delete(users);
	// テスト間のベクトル汚染除去(シングルトンのインメモリ実装のため)
	resetMemoryVectorStore();
	spySend();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("直接呼び出し(runScheduledPipeline+fixedClock)", () => {
	it("bucket: バケット到達の未評価機会Intentを評価し、バケット開始後の評価済みは再評価しない", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// starts_at=now−5分 → 属する30分バケットは到達済み(バケット開始≤now)
		const reached = intentFixture({
			id: ulid(),
			userId,
			form: "occasion",
			topic: "到達した学習会",
			startsAt: new Date(BASE - 5 * MIN),
			endsAt: new Date(BASE + 115 * MIN),
			expiresAt: new Date(BASE + 3 * HOUR),
		});
		const evaluatedRecently = intentFixture({
			id: ulid(),
			userId,
			form: "occasion",
			topic: "バケット開始後に評価済みの学習会",
			startsAt: new Date(BASE - 5 * MIN),
			endsAt: new Date(BASE + 115 * MIN),
			expiresAt: new Date(BASE + 3 * HOUR),
			lastEvaluatedAt: new Date(BASE - 1 * MIN),
		});
		await insertIntentRow(reached);
		await insertIntentRow(evaluatedRecently);
		await upsertVector(reached);
		await upsertVector(evaluatedRecently);

		await runScheduledPipeline(testEnv, directClock);

		// 未評価は評価実行(last_evaluated_atが付く・docs/06 §2(a))
		expect((await rowOf(reached.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		// last_evaluated_atがバケット開始(starts_atの30分刻み)より後なら対象外
		expect((await rowOf(evaluatedRecently.id))?.lastEvaluatedAt).toEqual(
			new Date(BASE - 1 * MIN),
		);
	});

	it("catch-up: 期限2時間以内・30分以上経過の機会Intentを再評価する(境界値を含む)", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		const common = {
			form: "occasion" as const,
			// starts_at=now−40分(属するバケット開始=now−60分)にして、4件すべてが
			// bucket走査の対象外(last_evaluated_atがバケット開始以降)になるようにする。
			// これでこの試験はcatch-up走査単独の選択条件を検証できる
			startsAt: new Date(BASE - 40 * MIN),
			endsAt: new Date(BASE + 80 * MIN),
		};
		// 対象: 期限まで1時間・前回評価から31分
		const inWindow = intentFixture({
			id: ulid(),
			userId,
			topic: "まもなく締め切りの学習会",
			...common,
			expiresAt: new Date(BASE + 1 * HOUR),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		// 対象(境界): 期限まで2時間ちょうど・前回評価から30分ちょうど
		const atBoundary = intentFixture({
			id: ulid(),
			userId,
			topic: "境界の学習会",
			...common,
			expiresAt: new Date(BASE + PIPELINE.CATCH_UP_WINDOW_MS),
			lastEvaluatedAt: new Date(BASE - PIPELINE.REEVALUATION_SUPPRESSION_MS),
		});
		// 対象外: 前回評価から10分(30分抑制中)
		const suppressed = intentFixture({
			id: ulid(),
			userId,
			topic: "抑制中の学習会",
			...common,
			expiresAt: new Date(BASE + 1 * HOUR),
			lastEvaluatedAt: new Date(BASE - 10 * MIN),
		});
		// 対象外: 期限まで3時間(窓の外)
		const farExpiry = intentFixture({
			id: ulid(),
			userId,
			topic: "まだ先の学習会",
			...common,
			expiresAt: new Date(BASE + 3 * HOUR),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		for (const row of [inWindow, atBoundary, suppressed, farExpiry]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		await runScheduledPipeline(testEnv, directClock);

		expect((await rowOf(inWindow.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect((await rowOf(atBoundary.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect((await rowOf(suppressed.id))?.lastEvaluatedAt).toEqual(
			new Date(BASE - 10 * MIN),
		);
		expect((await rowOf(farExpiry.id))?.lastEvaluatedAt).toEqual(
			new Date(BASE - 31 * MIN),
		);
	});

	it("期限切れ2窓: 期限経過でexpired化+候補closed+metadata同期、期限+7日でベクトル削除(再実行で二重削除なし)", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// #6相当(つながり): expires_at=now−1分
		const expiring = intentFixture({
			id: ulid(),
			userId,
			topic: "期限が過ぎた学習仲間",
			expiresAt: new Date(BASE - 1 * MIN),
			embeddedAt: new Date(BASE - 10 * MIN),
		});
		const healthy1 = intentFixture({
			id: ulid(),
			userId,
			topic: "継続する学習仲間その1",
			embeddedAt: new Date(BASE - 10 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		const healthy2 = intentFixture({
			id: ulid(),
			userId,
			topic: "継続する学習仲間その2",
			embeddedAt: new Date(BASE - 10 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		for (const row of [expiring, healthy1, healthy2]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}
		// expiringを含むcandidate(→closed)・含まないcandidate(→残る)・
		// 含むproposed(→残る: status=candidateのみがクローズ対象)
		await insertCandidate(expiring.id, healthy1.id, "candidate");
		await insertCandidate(healthy1.id, healthy2.id, "candidate");
		await insertCandidate(expiring.id, healthy2.id, "proposed");
		// グループ候補: expiringを含む行(→closed)と含まない行(→残る)
		await insertGroupCandidate([expiring.id, healthy1.id], FIXED_NOW);
		await insertGroupCandidate([healthy1.id, healthy2.id], FIXED_NOW);

		await runScheduledPipeline(testEnv, directClock);

		// 第1窓: expired化(つながり・#6相当)
		expect((await rowOf(expiring.id))?.status).toBe("expired");
		expect((await rowOf(healthy1.id))?.status).toBe("active");
		expect((await rowOf(healthy2.id))?.status).toBe("active");
		// 候補クローズ: 当該Intentを含むstatus=candidateのみclosed
		const [closed] = await candidateOfPair(expiring.id, healthy1.id);
		expect(closed?.status).toBe("closed");
		const [untouched] = await candidateOfPair(healthy1.id, healthy2.id);
		expect(untouched?.status).toBe("candidate");
		const [proposed] = await candidateOfPair(expiring.id, healthy2.id);
		expect(proposed?.status).toBe("proposed");
		// グループ候補クローズ: intent_idsに当該Intentを含むcandidateのみclosed
		const groupRows = await db.select().from(groupCandidates);
		const closingGroup = groupRows.find((row) =>
			row.intentIds.includes(expiring.id),
		);
		const keptGroup = groupRows.find(
			(row) => !row.intentIds.includes(expiring.id),
		);
		expect(closingGroup?.status).toBe("closed");
		expect(keptGroup?.status).toBe("candidate");
		// ベクトルmetadata.statusの同期(best-effort・docs/06 §2)
		expect((await vectorOf(expiring.id))?.metadata.status).toBe("expired");
		expect((await vectorOf(healthy1.id))?.metadata.status).toBe("active");

		// 第2窓: 期限切れ後7日経過でベクトル削除+vector_deleted_at記録
		const laterClock = fixedClock(new Date(BASE + 7 * MS_PER_DAY + 2 * MIN));
		const deleteSpy = vi.spyOn(memoryVectorStore(), "deleteByIds");
		await runScheduledPipeline(testEnv, laterClock);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(await vectorOf(expiring.id)).toBeNull();
		expect(await vectorOf(healthy1.id)).not.toBeNull();
		const deletedRow = await rowOf(expiring.id);
		expect(deletedRow?.vectorDeletedAt).toEqual(
			new Date(BASE + 7 * MS_PER_DAY + 2 * MIN),
		);
		expect(deletedRow?.status).toBe("expired");

		// Review Focus 5: もう1回実行しても削除は2度目なし(vector_deleted_at記録済み)
		await runScheduledPipeline(testEnv, laterClock);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		deleteSpy.mockRestore();
	});

	it("期限切れ2窓: 機会Intentも同一経路でexpired化される(expires_at=nowちょうどの境界を含む)", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		const expiring = intentFixture({
			id: ulid(),
			userId,
			form: "occasion",
			topic: "期限が過ぎた学習会",
			startsAt: new Date(BASE - 3 * HOUR),
			endsAt: new Date(BASE - 1 * HOUR),
			expiresAt: new Date(BASE),
			embeddedAt: new Date(BASE - 10 * MIN),
		});
		await insertIntentRow(expiring);
		await upsertVector(expiring);

		await runScheduledPipeline(testEnv, directClock);

		expect((await rowOf(expiring.id))?.status).toBe("expired");
		expect((await vectorOf(expiring.id))?.metadata.status).toBe("expired");
	});

	it("バックフィル: 埋め込み未完了が5分猶予を過ぎたら埋め込み+評価され、猶予内は回収しない", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// 対象: 生成から6分経過(猶予5分を過ぎた)
		const collected = intentFixture({
			id: ulid(),
			userId,
			topic: "回収される学習仲間",
			updatedAt: new Date(BASE - 6 * MIN),
		});
		// 対象(境界): 生成から5分ちょうど
		const atGrace = intentFixture({
			id: ulid(),
			userId,
			topic: "猶予ちょうどの学習仲間",
			updatedAt: new Date(BASE - PIPELINE.BACKFILL_GRACE_MS),
		});
		// 対象外: 生成から1分(猶予内)
		const inGrace = intentFixture({
			id: ulid(),
			userId,
			topic: "猶予内の学習仲間",
			updatedAt: new Date(BASE - 1 * MIN),
		});
		for (const row of [collected, atGrace, inGrace]) {
			await insertIntentRow(row);
		}

		await runScheduledPipeline(testEnv, directClock);

		// 埋め込み+評価まで完了(embedded_at/last_evaluated_at付与・ベクトル生成)
		const collectedRow = await rowOf(collected.id);
		expect(collectedRow?.embeddedAt).toEqual(FIXED_NOW);
		expect(collectedRow?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect(await vectorOf(collected.id)).not.toBeNull();
		const atGraceRow = await rowOf(atGrace.id);
		expect(atGraceRow?.embeddedAt).toEqual(FIXED_NOW);
		expect(await vectorOf(atGrace.id)).not.toBeNull();
		// 猶予内は回収しない
		const inGraceRow = await rowOf(inGrace.id);
		expect(inGraceRow?.embeddedAt).toBeNull();
		expect(await vectorOf(inGrace.id)).toBeNull();
	});

	it("未評価回収: 埋め込み済みで未評価のactive Intentを5分猶予の経過後に評価する", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// 対象: 埋め込みから6分経過・未評価
		const orphan = intentFixture({
			id: ulid(),
			userId,
			topic: "回収される未評価の学習仲間",
			embeddedAt: new Date(BASE - 6 * MIN),
		});
		// 対象(境界): 埋め込みから5分ちょうど
		const atGrace = intentFixture({
			id: ulid(),
			userId,
			topic: "猶予ちょうどの未評価学習仲間",
			embeddedAt: new Date(BASE - PIPELINE.BACKFILL_GRACE_MS),
		});
		// 対象外: 埋め込みから1分(猶予内)
		const inGrace = intentFixture({
			id: ulid(),
			userId,
			topic: "猶予内の未評価学習仲間",
			embeddedAt: new Date(BASE - 1 * MIN),
		});
		for (const row of [orphan, atGrace, inGrace]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		await runScheduledPipeline(testEnv, directClock);

		expect((await rowOf(orphan.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect((await rowOf(atGrace.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect((await rowOf(inGrace.id))?.lastEvaluatedAt).toBeNull();
	});

	it("遅延再評価: つながりを10分経過後に1回だけ再評価する(2度目は実行しない)", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		const target = intentFixture({
			id: ulid(),
			userId,
			topic: "遅延再評価される学習仲間",
			embeddedAt: new Date(BASE - 11 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
			delayedReevalAt: null,
		});
		await insertIntentRow(target);
		await upsertVector(target);

		await runScheduledPipeline(testEnv, directClock);

		// 評価+delayed_reeval_at記録(docs/06 §2(h))
		const first = await rowOf(target.id);
		expect(first?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect(first?.delayedReevalAt).toEqual(FIXED_NOW);

		// 1分進めて再実行 → 1回きりなので再評価されない
		await runScheduledPipeline(testEnv, fixedClock(new Date(BASE + 1 * MIN)));
		const second = await rowOf(target.id);
		expect(second?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect(second?.delayedReevalAt).toEqual(FIXED_NOW);
	});

	it("遅延再評価: 10分ちょうどで対象になり、10分未満と実行済みは対象外", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// 対象(境界): 埋め込みから10分ちょうど
		const atBoundary = intentFixture({
			id: ulid(),
			userId,
			topic: "境界の遅延再評価学習仲間",
			embeddedAt: new Date(BASE - PIPELINE.DELAYED_REEVAL_AFTER_MS),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		// 対象外: 埋め込みから9分(10分未満)
		const tooEarly = intentFixture({
			id: ulid(),
			userId,
			topic: "まだ早い学習仲間",
			embeddedAt: new Date(BASE - 9 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		// 対象外: 実行済み(delayed_reeval_atあり)
		const alreadyDone = intentFixture({
			id: ulid(),
			userId,
			topic: "実行済みの学習仲間",
			embeddedAt: new Date(BASE - 11 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
			delayedReevalAt: new Date(BASE - 5 * MIN),
		});
		for (const row of [atBoundary, tooEarly, alreadyDone]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		await runScheduledPipeline(testEnv, directClock);

		expect((await rowOf(atBoundary.id))?.delayedReevalAt).toEqual(FIXED_NOW);
		expect((await rowOf(tooEarly.id))?.delayedReevalAt).toBeNull();
		expect((await rowOf(tooEarly.id))?.lastEvaluatedAt).toEqual(
			new Date(BASE - 31 * MIN),
		);
		expect((await rowOf(alreadyDone.id))?.delayedReevalAt).toEqual(
			new Date(BASE - 5 * MIN),
		);
		expect((await rowOf(alreadyDone.id))?.lastEvaluatedAt).toEqual(
			new Date(BASE - 31 * MIN),
		);
	});

	it("metadata整合: metadata.status不一致を現行statusへ修正し、activeのベクトル欠損は再埋め込みする", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// 不一致: memory storeのstatus=active・D1=paused → pausedへ修正
		const paused = intentFixture({
			id: ulid(),
			userId,
			topic: "一時停止の学習仲間",
			status: "paused",
			embeddedAt: new Date(BASE - 10 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		// 欠損(active): D1は埋め込み済みだがベクトルが無い → 再埋め込み
		const missing = intentFixture({
			id: ulid(),
			userId,
			form: "occasion",
			topic: "ベクトル欠損の学習会",
			startsAt: new Date(BASE - 5 * MIN),
			endsAt: new Date(BASE + 115 * MIN),
			expiresAt: new Date(BASE + 3 * HOUR),
			embeddedAt: new Date(BASE - 10 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		// 欠損(paused): 新規候補化の対象外のため再埋め込みしない
		const missingPaused = intentFixture({
			id: ulid(),
			userId,
			topic: "停止中で欠損の学習仲間",
			status: "paused",
			embeddedAt: new Date(BASE - 10 * MIN),
			lastEvaluatedAt: new Date(BASE - 31 * MIN),
		});
		for (const row of [paused, missing, missingPaused]) {
			await insertIntentRow(row);
		}
		const seeded = await vectorFor(paused);
		await memoryVectorStore().upsert([seeded]);

		await runScheduledPipeline(testEnv, directClock);

		// 不一致は同じvaluesでmetadata.statusだけ現行statusへ書き替える
		const synced = await vectorOf(paused.id);
		expect(synced?.metadata.status).toBe("paused");
		expect(synced?.values).toEqual(seeded.values);
		// activeの欠損は再埋め込みされる(embedded_atが更新される)
		expect(await vectorOf(missing.id)).not.toBeNull();
		expect((await rowOf(missing.id))?.embeddedAt).toEqual(FIXED_NOW);
		// pausedの欠損は再埋め込みしない
		expect(await vectorOf(missingPaused.id)).toBeNull();
		expect((await rowOf(missingPaused.id))?.embeddedAt).toEqual(
			new Date(BASE - 10 * MIN),
		);
	});

	it("保持期間: 30日より前の1対1候補・グループ候補を削除する(新しい行は残る)", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		const intentA = intentFixture({
			id: ulid(),
			userId,
			topic: "保持試験その1",
		});
		const intentB = intentFixture({
			id: ulid(),
			userId,
			topic: "保持試験その2",
		});
		await insertIntentRow(intentA);
		await insertIntentRow(intentB);
		// 古い行(updated_at=now−31日・3件)は1回の実行で全て削除され、
		// 新しい行(updated_at=now−29日)は残る。versionはUNIQUE(a,b,va,vb)が
		// 重複しないよう専用の値を振る
		for (const version of [1, 3, 4]) {
			await insertCandidate(
				intentA.id,
				intentB.id,
				"candidate",
				new Date(BASE - 31 * MS_PER_DAY),
				{ a: version, b: 1 },
			);
		}
		await insertCandidate(
			intentA.id,
			intentB.id,
			"proposed",
			new Date(BASE - 29 * MS_PER_DAY),
			{ a: 2, b: 1 },
		);
		await insertGroupCandidate(
			[intentA.id, intentB.id],
			new Date(BASE - 31 * MS_PER_DAY),
		);
		await insertGroupCandidate(
			[intentA.id, intentB.id],
			new Date(BASE - 29 * MS_PER_DAY),
		);

		await runScheduledPipeline(testEnv, directClock);

		// beforeEachで全行を削除済みのため全件走査で照合する
		// (ULIDは同ミリ秒内で順序が不定のためintent_a_idでの絞り込みは行わない)
		const candidateRows = await db.select().from(matchCandidates);
		// 古いcandidateだけが消え、proposedの新しい行は保持期間内として残る
		expect(candidateRows).toHaveLength(1);
		expect(candidateRows[0]?.status).toBe("proposed");
		const groupRows = await db.select().from(groupCandidates);
		expect(groupRows).toHaveLength(1);
	});
});

describe("結線(index.tsのscheduledハンドラ)", () => {
	it("scheduledが1回の呼び出しでrunScheduledPipelineへ接続されている", async () => {
		const now = Date.now();
		const userId = ulid();
		await insertUserRow(userId);
		// 期限切れ(つながり)とbucket到達(機会)をsystemClock基準で投入する
		const expiring = intentFixture({
			id: ulid(),
			userId,
			topic: "結線試験の期限切れ学習仲間",
			expiresAt: new Date(now - 1 * MIN),
			embeddedAt: new Date(now - 10 * MIN),
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		const bucketTarget = intentFixture({
			id: ulid(),
			userId,
			form: "occasion",
			topic: "結線試験の学習会",
			startsAt: new Date(now - 5 * MIN),
			endsAt: new Date(now + 115 * MIN),
			expiresAt: new Date(now + 3 * HOUR),
			embeddedAt: new Date(now - 10 * MIN),
			lastEvaluatedAt: null,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		await insertIntentRow(expiring);
		await insertIntentRow(bucketTarget);
		await upsertVector(expiring);
		await upsertVector(bucketTarget);

		// index.tsのscheduledをcreateScheduledControllerで1回呼ぶ
		await worker.scheduled(
			createScheduledController(),
			testEnv,
			createExecutionContext(),
		);

		// 期限切れ2窓・bucket走査が動いている(結線の証明)
		expect((await rowOf(expiring.id))?.status).toBe("expired");
		expect((await rowOf(bucketTarget.id))?.lastEvaluatedAt).not.toBeNull();
	});
});
