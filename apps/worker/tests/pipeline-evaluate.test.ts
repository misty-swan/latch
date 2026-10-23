/**
 * 評価実行(第2段)の統合試験(docs/06 §2〜§4・§7)。
 * evaluateIntent(Layer 2 Candidate Retrieval→Layer 1→Layer 3→match_candidates
 * 保存→30分抑制→計測)とconsumer.tsのembedding_completed枝の置換を検証する。
 *
 * 2つのパターンを使い分ける:
 * - 統合パターン: SELF.fetchでIntentを作成(=イベント投入〜第1段まで実走)し、
 *   handleQueueBatchで消費を進めながらvi.waitUntilで行の出現を待つ
 * - 直接呼び出しパターン: 行を直接INSERT+memoryVectorStoreへ直接upsertし、
 *   evaluateIntentをfixedClockで直接呼ぶ(L1除外・K上限・抑制の精密検証)
 *
 * #7〜#11・#13相当(docs/02 §4)の証拠をpayload・戻り値・候補行で確認する。
 * 消費はcreateMessageBatchでhandleQueueBatchを直接呼ぶ
 * (pipeline-consumer.test.tsと同一パターン・TEST_QUEUES_DISABLED環境)。
 */

import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
	SELF,
} from "cloudflare:test";
import {
	type IntentDTO,
	type MatchQueueMessage,
	PIPELINE,
} from "@latch/shared";
import { eq, inArray, or, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { fixedClock, systemClock } from "../src/clock/clock";
import {
	blocks,
	intents,
	latches,
	latchMembers,
	matchCandidates,
	matchEvents,
	proposalHistory,
	users,
} from "../src/db/schema";
// ルート・handleQueueBatch・evaluateIntentが受け取るEnv(src/env.ts・生成型Envの宣言部分型)
import type { Env as WorkerEnv } from "../src/env";
import { stubEmbedding } from "../src/llm/stub/embedding";
import {
	JEV_LOW_MARKER,
	STUB_JEV_HIGH,
	STUB_JEV_LOW,
	stubJev,
} from "../src/llm/stub/jev";
import type { JevFn } from "../src/llm/types";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { evaluateIntent } from "../src/pipeline/evaluate";
import { pairKey } from "../src/pipeline/layer1";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	memoryVectorStore,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";
import type { StoredVector } from "../src/vectorstore/types";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 直接呼び出しパターンで固定する現在時刻(docs/04 §4のfixedClock)。JSTでは2026-06-01 09:00 */
const FIXED_NOW = new Date("2026-06-01T00:00:00Z");
const BASE = FIXED_NOW.getTime();
const directClock = fixedClock(FIXED_NOW);

/** テスト鍵の秘密JWK。viteの?rawでフィクスチャ文字列として読む(workerd内からは実FSを読めないため) */
const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

/** 署名鍵を遅延生成する(モジュール評価時に1回だけ) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/**
 * テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud)。
 * subは試験ごとにユニークにする
 */
const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(await signingKey());
};

/** JST=UTC+9の固定オフセット(誕生日計算をJST暦日基準に揃える・docs/01 §20) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 「JSTの今日からyears年前」の誕生日('YYYY-MM-DD')。統合試験はsystemClock(実時間)で動く */
const birthDateYearsAgo = (years: number): string => {
	const jstNow = new Date(Date.now() + JST_OFFSET_MS);
	return new Date(
		Date.UTC(
			jstNow.getUTCFullYear() - years,
			jstNow.getUTCMonth(),
			jstNow.getUTCDate(),
		),
	)
		.toISOString()
		.slice(0, 10);
};

/** JSONボディのPOSTリクエストヘルパー */
const postJson = (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

/** PATCHリクエストヘルパー */
const patchJson = (
	path: string,
	body: unknown,
	accessToken: string,
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "PATCH",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(body),
	});

/**
 * auth/token→POST /v1/usersで登録済みユーザーを作りアクセストークンを返す実フロー。
 * subjectは試験ごとにユニーク
 */
const registerUser = async (label: string): Promise<string> => {
	const tokenRes = await postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
	});
	expect(tokenRes.status).toBe(200);
	const tokenBody = (await tokenRes.json()) as {
		access_token: string;
		registration_required: boolean;
	};
	expect(tokenBody.registration_required).toBe(true);
	const regRes = await postJson(
		"/v1/users",
		{ display_name: `${label}テスト`, birth_date: birthDateYearsAgo(25) },
		{ Authorization: `Bearer ${tokenBody.access_token}` },
	);
	expect(regRes.status).toBe(201);
	const regBody = (await regRes.json()) as { access_token: string };
	return regBody.access_token;
};

/** つながりactiveを作りDTOを返す(POSTの既定status=active・イベントは即時投入) */
const createActiveConnection = async (
	accessToken: string,
	topic: string,
): Promise<IntentDTO> => {
	const res = await postJson(
		"/v1/intents",
		{
			raw_text: `${topic}。一緒にやりましょう。`,
			form: "connection",
			topic,
		},
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状・pipeline-consumer.test.tsと同一) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/** MATCH_QUEUE.sendを捕捉するモック。実キューへの投入は行わない */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());

/** Jevの保留が無いときの理由別内訳(F4a設計 §2.6) */
const NO_JEV_HELD = { budget: 0, breaker: 0, failed: 0, cap: 0 } as const;

/**
 * 1ペアがstub Jev(0.9)で閾値を超え提示まで進んだときのJev・Layer 5・提案化の計測値
 * (fixedClockのためJevの処理時間は0)
 */
const ONE_PROPOSED = {
	jevCalls: 1,
	jevReused: 0,
	jevHeld: NO_JEV_HELD,
	jevLatencyMs: 0,
	l5OverThreshold: 1,
	proposed: 1,
	held: 0,
} as const;

/** グループが組めない(Pool 2件未満)ときのF4bの計測値(F4b設計 §5) */
const NO_GROUP = {
	l4SkippedParticipants: 0,
	groupPool: 0,
	groupSets: 0,
	groupJevCalls: 0,
	groupHeldSets: 0,
	groupOverThreshold: 0,
	groupProposed: 0,
	groupHeldProposals: 0,
	groupFailed: 0,
	/** Candidate Retrievalの所要時間(実時間の計測のため値は固定しない) */
	retrievalMs: expect.any(Number),
} as const;

/** NO_GROUPのpayload表記(consumer.tsのキー名・F4b設計 §5) */
const NO_GROUP_PAYLOAD = {
	l4_skipped_participants: 0,
	group_pool: 0,
	group_sets: 0,
	group_jev_calls: 0,
	group_held_sets: 0,
	group_over_threshold: 0,
	group_proposed: 0,
	group_held_proposals: 0,
	group_failed: 0,
	/** Candidate Retrievalの所要時間(実時間の計測のため値は固定しない) */
	retrieval_ms: expect.any(Number),
} as const;

/** vi.waitUntilのタイムアウト(waitUntil内のINSERT完了待ち・CIの遅延を吸収) */
const WAIT = { timeout: 5_000, interval: 20 } as const;

/** 指定Intentのイベント行一覧 */
const eventsOf = (
	intentId: string,
): Promise<(typeof matchEvents.$inferSelect)[]> =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

/** 1対1候補のうち当該Intentをintent_a/bに含む行を取得する */
const candidatesInvolving = (
	intentId: string,
): Promise<(typeof matchCandidates.$inferSelect)[]> =>
	db
		.select()
		.from(matchCandidates)
		.where(
			or(
				eq(matchCandidates.intentAId, intentId),
				eq(matchCandidates.intentBId, intentId),
			) as SQL,
		);

/** 指定Intentのintents行を取得する */
const intentRowOf = async (intentId: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, intentId));
	return row;
};

/**
 * handleQueueBatchを直接呼んで結果(ack/retry状態)を返す。
 * バッチは指定キュー名で作り、メッセージ本体は{event_id}(sharedのMatchQueueMessage)
 */
const runBatch = async (
	queueName: string,
	eventIds: string[],
	clock: typeof systemClock = systemClock,
) => {
	const batch = createMessageBatch<MatchQueueMessage>(
		queueName,
		eventIds.map((eventId, index) => ({
			id: `msg-${index}`,
			timestamp: new Date(),
			attempts: 1,
			body: { event_id: eventId },
		})),
	);
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, testEnv, ctx, clock);
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

/**
 * 指定Intentのpendingイベントを枯れるまで消費する。第1段(intent_created/
 * intent_updated)→第1段が発行したembedding_completed→第2段(評価)の順に
 * 実処理が進む。ループ上限を設けて予期しない滞留で停止するようにする
 */
const consumePendingEvents = async (intentId: string): Promise<void> => {
	for (let round = 0; round < 10; round += 1) {
		const pending = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.sourceIntentId, intentId));
		const targets = pending.filter((e) => e.status === "pending");
		if (targets.length === 0) {
			return;
		}
		await runBatch(
			"match-events",
			targets.map((e) => e.id),
		);
	}
	throw new Error("pendingイベントが10巡でも枯れない(想定外の滞留)");
};

/** 直接INSERT用: users行を1件投入する */
const insertUserRow = async (id: string, birthDate = "1990-01-01") => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-evaluate-${id}`,
		actorType: "individual",
		displayName: "評価試験",
		bio: "",
		birthDate,
		status: "active",
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
	});
};

/**
 * intents行の完全なフィクスチャ(既定=つながり・地理なし・active・version=1)。
 * 指定のない欄は最小構成の値で埋める(layer1.test.tsのintentRowと同一方針)
 */
const intentFixture = (
	overrides: Partial<typeof intents.$inferSelect> &
		Pick<typeof intents.$inferSelect, "id" | "userId">,
): typeof intents.$inferSelect => ({
	form: "connection",
	topic: "評価試験の学習仲間",
	category: null,
	rawText: "評価試験用の入力文",
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
	expiresAt: new Date(BASE + 30 * 24 * 60 * 60_000),
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

/** embedding_completedイベント行を直接INSERTする(consumerの第2段枝への入力) */
const seedCompletedEvent = async (
	intentId: string,
	version = 1,
): Promise<string> => {
	const eventId = ulid();
	await db.insert(matchEvents).values({
		id: eventId,
		eventType: "embedding_completed",
		sourceIntentId: intentId,
		version,
		payload: {},
		status: "pending",
		createdAt: FIXED_NOW,
	});
	return eventId;
};

beforeEach(() => {
	// テスト間のベクトル汚染除去(シングルトンのインメモリ実装のため)
	resetMemoryVectorStore();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("統合パターン(SELF.fetch→イベント→第1段→第2段)", () => {
	beforeEach(() => {
		spySend();
	});

	it("#8相当: 2ユーザーのつながりIntentから候補行が生成される", async () => {
		const tokenA = await registerUser("eval-pair-a");
		const tokenB = await registerUser("eval-pair-b");
		const a = await createActiveConnection(tokenA, "週末のハイキング仲間");
		const b = await createActiveConnection(tokenB, "朝ランの仲間募集");

		// イベント投入(routeのwaitUntil)→第1段→第2段まで実走する
		await vi.waitUntil(async () => (await eventsOf(a.id)).length >= 1, WAIT);
		await consumePendingEvents(a.id);
		await vi.waitUntil(async () => (await eventsOf(b.id)).length >= 1, WAIT);
		await consumePendingEvents(b.id);

		const rows = await candidatesInvolving(a.id);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row === undefined) {
			throw new Error("候補行が生成されていない");
		}
		// a<b正規化・versions=1・スコア入り・status=candidate(docs/05 §2.2)
		const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
		expect(row.intentAId).toBe(aId);
		expect(row.intentBId).toBe(bId);
		expect(row.intentAVersion).toBe(1);
		expect(row.intentBVersion).toBe(1);
		expect(row.form).toBe("connection");
		expect(row.retrievalScore).toEqual(expect.any(Number));
		expect(row.cheapJudgeScore).toEqual(expect.any(Number));
		// stub Jev(0.9)で閾値を超え提案化まで進む(F4a設計 §3.1)
		expect(row.status).toBe("proposed");

		// 両者のlast_evaluated_atが設定される(docs/05 §2.6の抑制起点)
		expect((await intentRowOf(a.id))?.lastEvaluatedAt).not.toBeNull();
		expect((await intentRowOf(b.id))?.lastEvaluatedAt).not.toBeNull();

		// 起点イベントembedding_completedのpayloadに層通過が記録される(docs/06 §7)。
		// Bの評価時点でA・Bのベクトルが存在するため取得は2件(自id含む・除外前)で
		// 自id除外後のAがLayer 1を通過する
		const completedB = (await eventsOf(b.id)).find(
			(e) => e.eventType === "embedding_completed",
		);
		expect(completedB?.status).toBe("processed");
		expect(completedB?.payload).toEqual({
			retrieval_count: 2,
			l1_pass: 1,
			l1_exclusions: {},
			l3_pass: 1,
			l4_skipped_history: 0,
			jev_calls: 1,
			jev_reused: 0,
			jev_held: NO_JEV_HELD,
			// 統合パターンはsystemClock(実時間)のため処理時間は値を固定しない
			jev_latency: expect.any(Number),
			l5_over_threshold: 1,
			proposed: 1,
			held_proposals: 0,
			...NO_GROUP_PAYLOAD,
		});
	});

	it("更新: PATCH topic→再評価で新versionの候補行(旧version行も残る)", async () => {
		const tokenA = await registerUser("eval-upd-a");
		const tokenB = await registerUser("eval-upd-b");
		const a = await createActiveConnection(tokenA, "更新前の写真仲間");
		const b = await createActiveConnection(tokenB, "写真部の集まり");
		await vi.waitUntil(async () => (await eventsOf(a.id)).length >= 1, WAIT);
		await consumePendingEvents(a.id);
		await vi.waitUntil(async () => (await eventsOf(b.id)).length >= 1, WAIT);
		await consumePendingEvents(b.id);
		expect(await candidatesInvolving(a.id)).toHaveLength(1);

		// PATCHでtopicを変える(version+1・intent_updatedは10秒遅延で投入されるが
		// 消費はテストからの明示呼びのため遅延を待たず処理する)
		const patched = await patchJson(
			`/v1/intents/${a.id}`,
			{ topic: "更新後の写真仲間" },
			tokenA,
		);
		expect(patched.status).toBe(200);
		await vi.waitUntil(
			async () =>
				(await eventsOf(a.id)).some((e) => e.eventType === "intent_updated"),
			WAIT,
		);
		await consumePendingEvents(a.id);

		// 意味フィールドの更新で30分の再評価抑制は解除されるため(オーナー裁定 2026-10-20・
		// docs/06 §3)、直前の評価から30分以内でも新versionで再評価される(skippedにならない)
		const completedV2 = (await eventsOf(a.id)).find(
			(e) => e.eventType === "embedding_completed" && e.version === 2,
		);
		expect(completedV2?.status).toBe("processed");
		expect(completedV2?.payload).not.toHaveProperty("skipped");
		expect(completedV2?.payload).toHaveProperty("retrieval_count");

		// 新versionの候補行が作られ・旧versionの行も残る(docs/05 §2.2のUNIQUEは
		// (a,b,va,vb)単位のため併存する)
		const rows = await candidatesInvolving(a.id);
		expect(rows).toHaveLength(2);
		const versionPairs = rows
			.map((r) => [r.intentAVersion, r.intentBVersion])
			.sort((x, y) => x[0] - y[0]);
		expect(versionPairs).toEqual([
			[1, 1],
			[2, 1],
		]);
	});
});

describe("直接呼び出しパターン(行INSERT+ベクトルupsert+fixedClock)", () => {
	it("#9相当: 語彙が一致しない2文も候補化される", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({
			id: ulid(),
			userId: userA,
			topic: "個人開発仲間が欲しい",
			rawText: "個人開発仲間が欲しい",
		});
		const b = intentFixture({
			id: ulid(),
			userId: userB,
			topic: "Railsで何か作っている",
			rawText: "Railsで何か作っている",
		});
		await insertIntentRow(a);
		await insertIntentRow(b);
		await upsertVector(a);
		await upsertVector(b);

		const result = await evaluateIntent(testEnv, a.id, directClock);

		// stubベクトルは意味を持たないが、少数コーパスでは検索の取り出し幅
		// (topK=100)が当該ペアを確実に含むため候補化する(docs/10 §3のseed方針)。
		// Layer 3は順位付けのみで閾値判定は後続層のため語彙不一致でも保存される。
		// retrievalCount=2は自idを含む取得件数(自id除外後の1件が候補化)
		expect(result).toEqual({
			retrievalCount: 2,
			l1Pass: 1,
			exclusions: {},
			l3Pass: 1,
			l4SkippedHistory: 0,
			...ONE_PROPOSED,
			...NO_GROUP,
		});
		expect(await candidatesInvolving(a.id)).toHaveLength(1);
	});

	it("#10相当: 地理非添付・片方のみ添付のつながりも阻害されず候補化される", async () => {
		const userA = ulid();
		const userB = ulid();
		const userC = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		await insertUserRow(userC);
		// 起点と1件目は双方地理未添付(全国スコープ・docs/01 §12)
		const origin = intentFixture({
			id: ulid(),
			userId: userA,
			topic: "全国の学習仲間",
		});
		const bothNone = intentFixture({
			id: ulid(),
			userId: userB,
			topic: "北海道の学習仲間",
		});
		// 2件目は起点のみ地理添付(片方のみの組は地理判定を行わない・docs/06 §3)
		const oneSide = intentFixture({
			id: ulid(),
			userId: userC,
			topic: "沖縄の学習仲間",
			geoCenterLat: 26.2124,
			geoCenterLng: 127.6809,
			geoRadiusM: 500,
		});
		for (const row of [origin, bothNone, oneSide]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		// retrievalCount=3は自idを含む取得件数(自id除外後の2件が両方通過)
		// 別ユーザーの2ペアがそれぞれ閾値を超え、通知上限内のため両方提示される
		expect(result).toEqual({
			retrievalCount: 3,
			l1Pass: 2,
			exclusions: {},
			l3Pass: 2,
			l4SkippedHistory: 0,
			// 双方{2,3}のため3人集合{起点,2人}も組まれ、他人どうしの1ペア分だけJevを呼ぶ。
			// 起点ペアは1対1で提案済みのため集合は提案しない(F4b設計 §2.4・§3.6)
			jevCalls: 3,
			jevReused: 0,
			jevHeld: NO_JEV_HELD,
			jevLatencyMs: 0,
			l5OverThreshold: 2,
			proposed: 2,
			held: 0,
			l4SkippedParticipants: 0,
			groupPool: 2,
			groupSets: 1,
			groupJevCalls: 1,
			groupHeldSets: 0,
			groupOverThreshold: 1,
			groupProposed: 0,
			groupHeldProposals: 0,
			groupFailed: 0,
			retrievalMs: expect.any(Number),
		});
		expect(await candidatesInvolving(origin.id)).toHaveLength(2);
	});

	it("#11相当: D1が機会の候補はform_mismatchで除外されpayloadに載る", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const origin = intentFixture({
			id: ulid(),
			userId: userA,
			topic: "写真仲間",
		});
		// D1のform=機会・ベクトルmetadataはform=つながり(metadata同期遅延の模擬)。
		// Vectorizeのfilter(form一致)だけでは取りこぼす不一致をLayer 1のD1再検証が
		// 除外する(二重化・docs/06 §3)。実経路ではactiveのform変更が無いため
		// metadata不一致の直接seedで証明する
		const occasion = intentFixture({
			id: ulid(),
			userId: userB,
			form: "occasion",
			topic: "写真仲間",
			startsAt: new Date(BASE),
			endsAt: new Date(BASE + 2 * 60 * 60_000),
			expiresAt: new Date(BASE + 3 * 60 * 60_000),
		});
		await insertIntentRow(origin);
		await insertIntentRow(occasion);
		await upsertVector(origin);
		await upsertVector(occasion, { form: "connection" });

		const eventId = await seedCompletedEvent(origin.id);
		const result = await runBatch("match-events", [eventId], directClock);
		expectAcked(result);

		expect(await candidatesInvolving(origin.id)).toHaveLength(0);
		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(event?.status).toBe("processed");
		expect(event?.payload).toEqual({
			retrieval_count: 2,
			l1_pass: 0,
			l1_exclusions: { form_mismatch: 1 },
			l3_pass: 0,
			l4_skipped_history: 0,
			jev_calls: 0,
			jev_reused: 0,
			jev_held: NO_JEV_HELD,
			jev_latency: 0,
			l5_over_threshold: 0,
			proposed: 0,
			held_proposals: 0,
			...NO_GROUP_PAYLOAD,
		});
	});

	it("#13相当: ブロック・提案履歴・飲酒年齢・自己ペア・地理離れをそれぞれ除外する", async () => {
		const originUserId = ulid();
		const blockUserId = ulid();
		const historyUserId = ulid();
		const youngUserId = ulid();
		const okUserId = ulid();
		await insertUserRow(originUserId);
		await insertUserRow(blockUserId);
		await insertUserRow(historyUserId);
		// FIXED_NOW時点で19歳(layer1.test.tsと同じ日付固定・20歳 required)
		await insertUserRow(youngUserId, "2006-06-02");
		await insertUserRow(okUserId);

		const geoTokyo = {
			geoCenterLat: 35.6812,
			geoCenterLng: 139.7671,
			geoRadiusM: 500,
		};
		const geoOsaka = {
			geoCenterLat: 34.702,
			geoCenterLng: 135.4956,
			geoRadiusM: 500,
		};
		// 機会Intentの時間は全候補が起点と15分以上重なる同一窓(時間規則の一致)
		const occasionTimes = {
			startsAt: new Date(BASE),
			endsAt: new Date(BASE + 2 * 60 * 60_000),
			expiresAt: new Date(BASE + 3 * 60 * 60_000),
		};

		const origin = intentFixture({
			id: ulid(),
			userId: originUserId,
			form: "occasion",
			topic: "昼からの学習会",
			...occasionTimes,
			...geoTokyo,
		});
		const selfPair = intentFixture({
			id: ulid(),
			userId: originUserId,
			form: "occasion",
			topic: "自己ペアの学習会",
			...occasionTimes,
			...geoTokyo,
		});
		const blocked = intentFixture({
			id: ulid(),
			userId: blockUserId,
			form: "occasion",
			topic: "ブロック済みの学習会",
			...occasionTimes,
			...geoTokyo,
		});
		const history = intentFixture({
			id: ulid(),
			userId: historyUserId,
			form: "occasion",
			topic: "成立済みの学習会",
			...occasionTimes,
			...geoTokyo,
		});
		const young = intentFixture({
			id: ulid(),
			userId: youngUserId,
			form: "occasion",
			topic: "飲酒を伴う学習会",
			alcoholInvolved: true,
			...occasionTimes,
			...geoTokyo,
		});
		const far = intentFixture({
			id: ulid(),
			userId: okUserId,
			form: "occasion",
			topic: "遠方の学習会",
			...occasionTimes,
			...geoOsaka,
		});
		const ok = intentFixture({
			id: ulid(),
			userId: okUserId,
			form: "occasion",
			topic: "同一会場の学習会",
			...occasionTimes,
			...geoTokyo,
		});

		await db.insert(blocks).values({
			blockerUserId: originUserId,
			blockedUserId: blockUserId,
			createdAt: FIXED_NOW,
		});
		const [low, high] = pairKey(originUserId, historyUserId).split(":");
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: null,
			outcome: "matched",
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW,
		});

		for (const row of [origin, selfPair, blocked, history, young, far, ok]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		const eventId = await seedCompletedEvent(origin.id);
		const result = await runBatch("match-events", [eventId], directClock);
		expectAcked(result);

		// 同一会場のokだけが候補化する(a<b正規化・docs/05 §2.2)
		const rows = await candidatesInvolving(origin.id);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row === undefined) {
			throw new Error("候補行が生成されていない");
		}
		expect(row.intentAId < row.intentBId).toBe(true);
		expect(new Set([row.intentAId, row.intentBId])).toEqual(
			new Set([origin.id, ok.id]),
		);

		// 除外理由がpayloadのLayer 1内訳に理由別件数で載る(docs/06 §7)。
		// retrieval_count=7は自idを含む全ベクトル(自id除外前のVectorize取得件数)
		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(event?.payload).toEqual({
			retrieval_count: 7,
			l1_pass: 1,
			l1_exclusions: {
				self_pair: 1,
				blocked: 1,
				proposal_history: 1,
				alcohol_under_age: 1,
				geo_no_overlap: 1,
			},
			l3_pass: 1,
			l4_skipped_history: 0,
			// 閾値は超えるが、機会の開始時刻=現在で対象時刻まで75分未満のため
			// 提案しない(docs/01 §8)
			jev_calls: 1,
			jev_reused: 0,
			jev_held: NO_JEV_HELD,
			jev_latency: 0,
			l5_over_threshold: 1,
			proposed: 0,
			held_proposals: 0,
			...NO_GROUP_PAYLOAD,
		});
	});

	it("payloadのretrieval_msは0以上の数", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({ id: ulid(), userId: userA });
		const b = intentFixture({ id: ulid(), userId: userB });
		await insertIntentRow(a);
		await insertIntentRow(b);
		await upsertVector(a);
		await upsertVector(b);

		const eventId = await seedCompletedEvent(a.id);
		expectAcked(await runBatch("match-events", [eventId], directClock));
		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		const payload = event?.payload as Record<string, number>;
		expect(payload.retrieval_ms).toBeGreaterThanOrEqual(0);
	});

	it("#7相当: 150候補で検索100・L1上位50・L3上位20に頭打ちになる", async () => {
		const originUserId = ulid();
		await insertUserRow(originUserId);
		const origin = intentFixture({
			id: ulid(),
			userId: originUserId,
			topic: "評価上限試験の基点",
			category: "学び・語学",
		});
		await insertIntentRow(origin);
		await upsertVector(origin);

		// 150件の候補(ユーザー+Intent+ベクトルを直接投入)。全てLayer 1を
		// 通過する内容(つながり・地理なし・participants 2〜3)で揃える
		const userDefs: { id: string; birthDate: string }[] = [];
		const candidateRows: (typeof intents.$inferSelect)[] = [];
		for (let i = 0; i < 150; i += 1) {
			const uid = ulid();
			userDefs.push({ id: uid, birthDate: "1990-01-01" });
			candidateRows.push(
				intentFixture({
					id: ulid(),
					userId: uid,
					topic: `学習仲間${String(i).padStart(3, "0")}`,
					category: "学び・語学",
				}),
			);
		}
		// D1のバインド上限(100)対策で分割INSERTする(users 10列×8行・intents 33列×2行)
		for (let i = 0; i < userDefs.length; i += 8) {
			await db.insert(users).values(
				userDefs.slice(i, i + 8).map((d) => ({
					id: d.id,
					authProvider: "google" as const,
					authSubject: `pipeline-evaluate-${d.id}`,
					actorType: "individual" as const,
					displayName: "大量候補",
					bio: "",
					birthDate: d.birthDate,
					status: "active" as const,
					createdAt: FIXED_NOW,
					updatedAt: FIXED_NOW,
				})),
			);
		}
		for (let i = 0; i < candidateRows.length; i += 2) {
			await db.insert(intents).values(candidateRows.slice(i, i + 2));
		}
		const vectors: StoredVector[] = [];
		for (const row of candidateRows) {
			vectors.push(await vectorFor(row));
		}
		await memoryVectorStore().upsert(vectors);

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		// Vectorize取得はtopK=100で頭打ち(151ベクトル中・自idを含む)
		expect(result?.retrievalCount).toBe(100);
		// Layer 1通過(自id除外後の99件が全通過)のうち上位K_v=50だけを次層へ(docs/06 §3)
		expect(result?.l1Pass).toBeLessThanOrEqual(PIPELINE.LAYER1_OUTPUT_MAX);
		expect(result?.l1Pass).toBe(50);
		// Layer 3通過は上位K_c=20(docs/06 §3)
		expect(result?.l3Pass).toBeLessThanOrEqual(PIPELINE.LAYER3_OUTPUT_MAX);
		expect(result?.l3Pass).toBe(20);

		const rows = await candidatesInvolving(origin.id);
		expect(rows).toHaveLength(20);
		for (const row of rows) {
			expect(row.intentAId < row.intentBId).toBe(true);
			// Jevの対象(K_j=8)のうち通知上限内の分は提案化まで進む(F4a設計 §3.3)
			expect(["candidate", "proposed"]).toContain(row.status);
			expect(row.intentAVersion).toBe(1);
			expect(row.intentBVersion).toBe(1);
		}
	});

	it("upsertは冪等: 同一ペアの再評価で候補行は増えない", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({ id: ulid(), userId: userA });
		const b = intentFixture({ id: ulid(), userId: userB });
		await insertIntentRow(a);
		await insertIntentRow(b);
		await upsertVector(a);
		await upsertVector(b);

		await evaluateIntent(testEnv, a.id, directClock);
		// 再評価の抑制を解除してから再度評価(別方向bからの評価も同一正規化ペア)
		await db
			.update(intents)
			.set({ lastEvaluatedAt: null })
			.where(eq(intents.id, a.id));
		await evaluateIntent(testEnv, b.id, directClock);

		// UNIQUE(a,b,va,vb)のON CONFLICT DO UPDATEで行は増えない(docs/05 §2.2)
		const rows = await candidatesInvolving(a.id);
		expect(rows).toHaveLength(1);
	});
});

describe("options.vector(第1段から渡されたベクトル)", () => {
	it("options.vectorで照会し、ストアに自分のベクトルが無くても評価する", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({ id: ulid(), userId: userA });
		const b = intentFixture({ id: ulid(), userId: userB });
		await insertIntentRow(a);
		await insertIntentRow(b);
		// 自分(a)のベクトルはストアに置かず、相手(b)だけ置く
		await upsertVector(b);
		const own = await vectorFor(a);

		const result = await evaluateIntent(testEnv, a.id, directClock, {
			vector: own.values,
		});

		expect(result).not.toBeNull();
		expect(result?.retrievalCount).toBeGreaterThanOrEqual(1);
	});

	it("ignoreSuppression=trueなら30分抑制を無視して評価する", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({
			id: ulid(),
			userId: userA,
			lastEvaluatedAt: new Date(BASE - 5 * 60_000),
		});
		const b = intentFixture({ id: ulid(), userId: userB });
		await insertIntentRow(a);
		await insertIntentRow(b);
		await upsertVector(a);
		await upsertVector(b);

		expect(await evaluateIntent(testEnv, a.id, directClock)).toBeNull();
		expect(
			await evaluateIntent(testEnv, a.id, directClock, {
				ignoreSuppression: true,
			}),
		).not.toBeNull();
	});
});

describe("30分抑制と対象外(docs/06 §4)", () => {
	it("抑制: last_evaluated_atから30分未満は評価せず何も書かない", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		const candidateUser = ulid();
		await insertUserRow(candidateUser);
		const fiveMinAgo = new Date(BASE - 5 * 60_000);
		const origin = intentFixture({
			id: ulid(),
			userId,
			lastEvaluatedAt: fiveMinAgo,
		});
		const candidate = intentFixture({ id: ulid(), userId: candidateUser });
		await insertIntentRow(origin);
		await insertIntentRow(candidate);
		await upsertVector(origin);
		await upsertVector(candidate);

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		expect(result).toBeNull();
		expect(await candidatesInvolving(origin.id)).toHaveLength(0);
		// 何も書かない(last_evaluated_atが更新されない)
		const row = await intentRowOf(origin.id);
		expect(row?.lastEvaluatedAt?.getTime()).toBe(fiveMinAgo.getTime());
	});

	it("境界: last_evaluated_atからちょうど30分は評価する", async () => {
		const userId = ulid();
		const candidateUser = ulid();
		await insertUserRow(userId);
		await insertUserRow(candidateUser);
		const origin = intentFixture({
			id: ulid(),
			userId,
			lastEvaluatedAt: new Date(BASE - PIPELINE.REEVALUATION_SUPPRESSION_MS),
		});
		const candidate = intentFixture({ id: ulid(), userId: candidateUser });
		await insertIntentRow(origin);
		await insertIntentRow(candidate);
		await upsertVector(origin);
		await upsertVector(candidate);

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		// 抑制条件は「30分未満」のためちょうど30分は評価される(docs/06 §4)
		expect(result).not.toBeNull();
		expect(result?.l3Pass).toBe(1);
		const row = await intentRowOf(origin.id);
		expect(row?.lastEvaluatedAt?.getTime()).toBe(BASE);
	});

	it("対象外: status≠active・行不在・ベクトル不在は何もせずnull", async () => {
		const userId = ulid();
		await insertUserRow(userId);
		// paused(ベクトルが残っていても対象外)
		const paused = intentFixture({ id: ulid(), userId, status: "paused" });
		await insertIntentRow(paused);
		await upsertVector(paused);
		expect(await evaluateIntent(testEnv, paused.id, directClock)).toBeNull();
		// 行不在
		expect(await evaluateIntent(testEnv, ulid(), directClock)).toBeNull();
		// ベクトル不在(active・埋め込み未完了=バックフィル対象外パス・docs/06 §2)
		const noVector = intentFixture({ id: ulid(), userId });
		await insertIntentRow(noVector);
		expect(await evaluateIntent(testEnv, noVector.id, directClock)).toBeNull();
		expect((await intentRowOf(noVector.id))?.lastEvaluatedAt).toBeNull();
		// いずれも候補行を作らない
		expect(await candidatesInvolving(paused.id)).toHaveLength(0);
		expect(await candidatesInvolving(noVector.id)).toHaveLength(0);
	});
});

describe("孤立したベクトルの自己修復(#20・設計 §5.2)", () => {
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

	/**
	 * 起点(active・ベクトルあり)と、D1に行の無い孤立ベクトルorphanCount件・行のあるhit
	 * (反映待ちでmetadataがactiveのままのpaused・相手のactive)を置く
	 */
	const seedOrphans = async (orphanCount: number) => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const origin = intentFixture({ id: ulid(), userId: userA });
		const partner = intentFixture({ id: ulid(), userId: userB });
		const lagging = intentFixture({
			id: ulid(),
			userId: userB,
			topic: "一時停止したばかりの学習仲間",
			status: "paused",
		});
		for (const row of [origin, partner, lagging]) {
			await insertIntentRow(row);
			// laggingもmetadataはactiveのまま(paused化の同期の反映待ち)
			await upsertVector(row);
		}
		const orphanIds: string[] = [];
		for (let i = 0; i < orphanCount; i += 1) {
			// 行を作らずにベクトルだけを置く(削除の後に残ったベクトル)
			const ghost = intentFixture({
				id: ulid(),
				userId: ulid(),
				topic: `削除済みの学習仲間${i}`,
			});
			await upsertVector(ghost);
			orphanIds.push(ghost.id);
		}
		return { origin, partner, lagging, orphanIds };
	};

	it("D1に行の無いhitを10件まで消し、件数だけをログに出す。行のあるhitは消さない", async () => {
		const { origin, partner, lagging, orphanIds } = await seedOrphans(12);
		const store = memoryVectorStore();
		const deleteSpy = vi.spyOn(store, "deleteByIds");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		expect(result).not.toBeNull();
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		const deleted = deleteSpy.mock.calls[0]?.[0] ?? [];
		expect(deleted).toHaveLength(PIPELINE.ORPHAN_DELETE_MAX);
		expect(PIPELINE.ORPHAN_DELETE_MAX).toBe(10);
		for (const id of deleted) {
			expect(orphanIds).toContain(id);
		}
		const remaining = await store.getByIds(orphanIds);
		expect(remaining.filter((v) => v !== null)).toHaveLength(2);
		// 行のあるhit(相手・反映待ちのpaused)と起点は残る
		const kept = await store.getByIds([origin.id, partner.id, lagging.id]);
		expect(kept.every((v) => v !== null)).toBe(true);
		expect(logsOf(logSpy, "pipeline.orphan.deleted")).toEqual([
			{ level: "info", event: "pipeline.orphan.deleted", count: 10 },
		]);
	});

	it("孤立したベクトルが無ければ消さず、ログも出さない", async () => {
		const { origin } = await seedOrphans(0);
		const deleteSpy = vi.spyOn(memoryVectorStore(), "deleteByIds");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await evaluateIntent(testEnv, origin.id, directClock);

		expect(deleteSpy).not.toHaveBeenCalled();
		expect(logsOf(logSpy, "pipeline.orphan.deleted")).toEqual([]);
	});

	it("孤立したベクトルの削除が失敗しても、評価は結果を返しwarnだけを出す", async () => {
		const { origin } = await seedOrphans(1);
		vi.spyOn(memoryVectorStore(), "deleteByIds").mockRejectedValue(
			new Error("VECTOR_DELETE_ERROR (code = 40012): x"),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		expect(result).not.toBeNull();
		const warns = logsOf(logSpy, "pipeline.orphan.failed");
		expect(warns).toHaveLength(1);
		expect(warns[0]?.level).toBe("warn");
		expect(warns[0]?.count).toBe(1);
	});
});

/**
 * 本番のAnalytics Engineと同じ上限で検査する偽物(1つのdata pointにblobs 20・doubles 20・
 * index 1まで)。ローカルの模擬(miniflare)のwriteDataPointは何もしないため、上限を
 * 超えても試験では例外にならない。stagingでは超えるとTypeError
 * 「writeDataPoint(): Maximum of 20 doubles supported.」となり、評価全体が失敗した(#8)
 */
const strictAx = () => {
	const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] =
		[];
	return {
		points,
		writeDataPoint: vi.fn(
			(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) => {
				const blobs = point.blobs ?? [];
				const doubles = point.doubles ?? [];
				const indexes = point.indexes ?? [];
				if (doubles.length > 20) {
					throw new TypeError(
						"writeDataPoint(): Maximum of 20 doubles supported.",
					);
				}
				if (blobs.length > 20) {
					throw new TypeError(
						"writeDataPoint(): Maximum of 20 blobs supported.",
					);
				}
				if (indexes.length > 1) {
					throw new TypeError(
						"writeDataPoint(): Maximum of 1 index supported.",
					);
				}
				points.push({ blobs, doubles, indexes });
			},
		),
	};
};

describe("計測(Analytics Engine・docs/06 §7)", () => {
	it("層通過のdata pointを本番の上限内で書き・PIPELINE_AX未バインドでも例外を出さない", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const a = intentFixture({ id: ulid(), userId: userA });
		const b = intentFixture({ id: ulid(), userId: userB });
		await insertIntentRow(a);
		await insertIntentRow(b);
		await upsertVector(a);
		await upsertVector(b);

		const fakeAx = strictAx();
		const envWithAx = {
			...testEnv,
			PIPELINE_AX: fakeAx,
		} as unknown as WorkerEnv;
		// 上限を超えるdata pointを書くと例外になり、評価がここで失敗する(#8)
		const result = await evaluateIntent(envWithAx, a.id, directClock);
		expect(result).toEqual({
			retrievalCount: 2,
			l1Pass: 1,
			exclusions: {},
			l3Pass: 1,
			l4SkippedHistory: 0,
			...ONE_PROPOSED,
			...NO_GROUP,
		});
		// 1対1の層通過("stage2")とグループの項目("stage2_group")の2つのdata pointに分ける
		expect(fakeAx.writeDataPoint).toHaveBeenCalledTimes(2);
		const [stage2, group] = fakeAx.points;
		// blob=処理段の識別・Layer 1の除外理由別内訳(JSON)。doubles=層通過件数
		// (Vectorize取得→L1→L3)・処理時間・Jev(呼び出し・再利用・保留4理由・処理時間)・
		// L5閾値超過・提示・保留、最後にretrievalMs(Layer 2の所要時間・実時間のため値は固定しない)
		// (fixedClockのため処理時間は0・retrievalCount=2は自id含む取得件数)
		expect(stage2?.blobs).toEqual([
			"stage2",
			"{}",
			"cron_other",
			expect.any(String),
		]);
		expect(stage2?.indexes).toEqual(["stage2"]);
		expect(stage2?.doubles).toHaveLength(15);
		expect(stage2?.doubles.slice(0, 14)).toEqual([
			2, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0,
		]);
		expect(stage2?.doubles[14]).toBeGreaterThanOrEqual(0);
		expect(stage2?.doubles[14]).toBe(result?.retrievalMs);
		// F4bの項目(l4_skipped_participants・group_pool・group_sets・group_jev_calls・
		// group_held_sets・group_over_threshold・group_proposed・group_held_proposals・
		// group_failed)
		expect(group?.blobs).toEqual([
			"stage2_group",
			"cron_other",
			expect.any(String),
		]);
		// 2件のjoinKeyは同じ。意思のid・イベントのidを含まない
		expect(group?.blobs[2]).toBe(stage2?.blobs[3]);
		expect(stage2?.blobs[3]).not.toContain(a.id);
		expect(group?.indexes).toEqual(["stage2_group"]);
		expect(group?.doubles).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

		// PIPELINE_AXが未バインドの環境(単体試験等)でも評価自体は完走する
		const envWithoutAx = {
			...testEnv,
			PIPELINE_AX: undefined,
		} as unknown as WorkerEnv;
		const second = await evaluateIntent(envWithoutAx, b.id, directClock);
		expect(second).not.toBeNull();
		expect(fakeAx.writeDataPoint).toHaveBeenCalledTimes(2);
	});

	it("originを渡すと2件のblobに載り、joinKeyは評価ごとに違う", async () => {
		const { origin } = await seedConnectionPair();
		const fakeAx = strictAx();
		const env = { ...testEnv, PIPELINE_AX: fakeAx } as unknown as WorkerEnv;
		await evaluateIntent(env, origin.id, directClock, {
			origin: "embedding_completed",
			ignoreSuppression: true,
		});
		await evaluateIntent(env, origin.id, directClock, {
			origin: "cron_delayed",
			ignoreSuppression: true,
		});
		const [s1, g1, s2, g2] = fakeAx.points;
		expect(s1?.blobs[2]).toBe("embedding_completed");
		expect(g1?.blobs[1]).toBe("embedding_completed");
		expect(s2?.blobs[2]).toBe("cron_delayed");
		expect(g2?.blobs[1]).toBe("cron_delayed");
		expect(s1?.blobs[3]).toBe(g1?.blobs[2]);
		expect(s2?.blobs[3]).toBe(g2?.blobs[2]);
		expect(s1?.blobs[3]).not.toBe(s2?.blobs[3]);
		for (const p of fakeAx.points) {
			expect(p.blobs.length).toBeLessThanOrEqual(20);
			expect(p.blobs.join("|")).not.toContain(origin.id);
		}
	});

	it("writeDataPointが例外を出しても評価は結果を返し、提案は残り、warnが出る", async () => {
		const { userA, origin } = await seedConnectionPair();
		const throwingEnv = {
			...testEnv,
			PIPELINE_AX: {
				writeDataPoint: () => {
					throw new TypeError(
						"writeDataPoint(): Maximum of 20 doubles supported.",
					);
				},
			},
		} as unknown as WorkerEnv;
		const logSpy = vi.spyOn(console, "log");
		const result = await evaluateIntent(throwingEnv, origin.id, directClock);
		expect(result).not.toBeNull();
		expect(result?.proposed).toBe(1);
		expect(await latchesOfUser(userA)).toHaveLength(1);
		const warns = logSpy.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.includes("pipeline.metrics.failed"));
		expect(warns).toHaveLength(1);
		const parsed = JSON.parse(warns[0] as string);
		expect(parsed.level).toBe("warn");
		expect(parsed.error_code).toBe("TypeError");
		logSpy.mockRestore();
	});
});

/** 指定ユーザーが参加するLATCH行の一覧(latch_members経由) */
const latchesOfUser = async (
	userId: string,
): Promise<(typeof latches.$inferSelect)[]> => {
	const members = await db
		.select()
		.from(latchMembers)
		.where(eq(latchMembers.userId, userId));
	if (members.length === 0) {
		return [];
	}
	return db
		.select()
		.from(latches)
		.where(
			inArray(
				latches.id,
				members.map((m) => m.latchId),
			),
		);
};

/** 起点と相手のつながりIntent(別ユーザー)を行INSERT+ベクトルupsertで配置する */
const seedConnectionPair = async (otherTopic = "評価試験の学習仲間") => {
	const userA = ulid();
	const userB = ulid();
	await insertUserRow(userA);
	await insertUserRow(userB);
	const origin = intentFixture({ id: ulid(), userId: userA });
	const other = intentFixture({ id: ulid(), userId: userB, topic: otherTopic });
	for (const row of [origin, other]) {
		await insertIntentRow(row);
		await upsertVector(row);
	}
	return { userA, userB, origin, other };
};

describe("Layer 4・Layer 5・提案化の連結(F4a設計 §2.6・§3.1)", () => {
	it("一致するつながりIntent 2件でLATCHが1件proposedになりpayloadにJevと提案の計測が載る", async () => {
		const { userA, userB, origin } = await seedConnectionPair();

		const eventId = await seedCompletedEvent(origin.id);
		expectAcked(await runBatch("match-events", [eventId], directClock));

		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(event?.status).toBe("processed");
		const payload = event?.payload as Record<string, unknown>;
		expect(payload.jev_calls).toBeGreaterThanOrEqual(1);
		expect(payload).toMatchObject({
			jev_reused: 0,
			jev_held: { budget: 0, breaker: 0, failed: 0, cap: 0 },
			jev_latency: 0,
			l5_over_threshold: 1,
			proposed: 1,
			held_proposals: 0,
			...NO_GROUP_PAYLOAD,
		});

		// 双方が参加するLATCHが1件・status=proposed
		const latchesA = await latchesOfUser(userA);
		expect(latchesA).toHaveLength(1);
		expect(latchesA[0]?.status).toBe("proposed");
		expect((await latchesOfUser(userB)).map((l) => l.id)).toEqual(
			latchesA.map((l) => l.id),
		);
		// 候補行にstub Jev(0.9)由来のlatch_scoreが保存され、提案済みになる
		const [row] = await candidatesInvolving(origin.id);
		expect(row?.latchScore).toBeCloseTo(STUB_JEV_HIGH);
		expect(row?.status).toBe("proposed");
	});

	it("提案済みペアを反対側のIntentから再評価しても候補行はproposedのまま", async () => {
		const { origin, other } = await seedConnectionPair();
		const first = await evaluateIntent(testEnv, origin.id, directClock);
		expect(first?.proposed).toBe(1);

		// 相手側はlast_evaluated_atが未設定のため抑制されずに評価される。
		// 同一version同士のため同じ候補行へのupsert(ON CONFLICT)になる
		const second = await evaluateIntent(testEnv, other.id, directClock);
		expect(second?.l3Pass).toBe(1);
		// つながりの既存履歴により提案できないペアはLayer 4へ渡さない(Jev枠・予算を使わない)
		expect(second?.l4SkippedHistory).toBe(1);
		expect(second?.jevReused).toBe(0);
		expect(second?.jevCalls).toBe(0);
		expect(second?.proposed).toBe(0);

		const rows = await candidatesInvolving(origin.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("proposed");
	});

	it("履歴がproposedのペアにはJevを呼ばず、payloadにl4_skipped_historyを記録する", async () => {
		const { userA, userB, origin } = await seedConnectionPair();
		const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: null,
			outcome: "proposed",
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW,
		});

		const eventId = await seedCompletedEvent(origin.id);
		expectAcked(await runBatch("match-events", [eventId], directClock));

		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		const payload = event?.payload as Record<string, unknown>;
		expect(payload).toMatchObject({
			l3_pass: 1,
			jev_calls: 0,
			jev_reused: 0,
			l4_skipped_history: 1,
			proposed: 0,
		});
		const [row] = await candidatesInvolving(origin.id);
		expect(row?.jevResult).toBeNull();
		expect(row?.latchScore).toBeNull();
		expect(row?.status).toBe("candidate");
	});

	it("#14: 候補25件でもJev呼び出しは1イベント8回以下", async () => {
		const originUserId = ulid();
		await insertUserRow(originUserId);
		const origin = intentFixture({ id: ulid(), userId: originUserId });
		await insertIntentRow(origin);
		await upsertVector(origin);
		for (let i = 0; i < 25; i += 1) {
			const uid = ulid();
			await insertUserRow(uid);
			const row = intentFixture({
				id: ulid(),
				userId: uid,
				topic: `学習仲間${String(i).padStart(2, "0")}`,
			});
			await insertIntentRow(row);
			await upsertVector(row);
		}

		const eventId = await seedCompletedEvent(origin.id);
		expectAcked(await runBatch("match-events", [eventId], directClock));

		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		const payload = event?.payload as Record<string, number>;
		// Layer 3通過は上位K_c=20・Jevはそのうち1イベントK_j=8回まで(docs/06 §5)
		expect(payload.l3_pass).toBe(PIPELINE.LAYER3_OUTPUT_MAX);
		expect(payload.jev_calls).toBeGreaterThanOrEqual(1);
		expect(payload.jev_calls).toBeLessThanOrEqual(8);
	});

	it("相手のtopicが低値マーカーならlatch_score=0.3を保存し提案しない", async () => {
		const { userA, origin } = await seedConnectionPair(
			`${JEV_LOW_MARKER} 学習仲間`,
		);

		const result = await evaluateIntent(testEnv, origin.id, directClock);

		expect(result?.jevCalls).toBe(1);
		expect(result?.l5OverThreshold).toBe(0);
		expect(result?.proposed).toBe(0);
		expect(result?.held).toBe(0);
		const [row] = await candidatesInvolving(origin.id);
		expect(row?.latchScore).toBeCloseTo(STUB_JEV_LOW);
		expect(row?.status).toBe("candidate");
		expect(await latchesOfUser(userA)).toHaveLength(0);
	});

	it("Layer 4完了後〜Layer 5前に相手がpausedになると提案しない(Hの再検証)", async () => {
		const { userA, origin, other } = await seedConnectionPair();
		// 呼ばれた時に相手Intentをpausedにしてからstub Jev(0.9)の結果を返すfake
		const pausingJev: JevFn = async (input) => {
			await db
				.update(intents)
				.set({ status: "paused" })
				.where(eq(intents.id, other.id));
			return stubJev(input);
		};

		const result = await evaluateIntent(testEnv, origin.id, directClock, {
			jev: { primary: pausingJev, fallback: pausingJev },
		});

		// 閾値は超えるが、提案直前のHの再検証で除外され提案されない
		expect(result?.jevCalls).toBe(1);
		expect(result?.l5OverThreshold).toBe(1);
		expect(result?.proposed).toBe(0);
		expect(result?.held).toBe(0);
		expect(await latchesOfUser(userA)).toHaveLength(0);
		const [row] = await candidatesInvolving(origin.id);
		expect(row?.latchScore).toBeCloseTo(STUB_JEV_HIGH);
		expect(row?.status).toBe("candidate");
	});

	it("双方{3,3}の2人だけなら1対1のLATCHを作らずl4_skipped_participantsに数える(F4b設計 §2.1)", async () => {
		const userA = ulid();
		const userB = ulid();
		await insertUserRow(userA);
		await insertUserRow(userB);
		const only3 = { participantsMin: 3, participantsMax: 3 };
		const origin = intentFixture({ id: ulid(), userId: userA, ...only3 });
		const other = intentFixture({ id: ulid(), userId: userB, ...only3 });
		for (const row of [origin, other]) {
			await insertIntentRow(row);
			await upsertVector(row);
		}

		const eventId = await seedCompletedEvent(origin.id);
		expectAcked(await runBatch("match-events", [eventId], directClock));

		const [event] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(event?.payload).toMatchObject({
			l3_pass: 1,
			l4_skipped_history: 0,
			l4_skipped_participants: 1,
			jev_calls: 0,
			proposed: 0,
			group_pool: 0,
			group_proposed: 0,
		});
		expect(await latchesOfUser(userA)).toHaveLength(0);
		const [row] = await candidatesInvolving(origin.id);
		expect(row?.jevResult).toBeNull();
	});
});
