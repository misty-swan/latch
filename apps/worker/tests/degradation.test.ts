/**
 * 縮退試験(docs/10 §6・障害時の挙動)の統合試験。本物の外部サービスは止めず、課金のある
 * AIも呼ばず、差し替え口で障害を作る:
 * - Jevの全断: evaluateIntentのoptions.jev(src/llm/types.tsのJevFn)を常にtimeoutにする
 * - Embeddingの全断: LATCH_EMBEDDING_MODE=realとWorkers AIの代わり(AI.runが常に例外)
 * - D1の長時間障害: env.DBを常に失敗するD1に差し替える
 * 時刻はfixedClock(docs/04 §4)で進める。Queues消費の失敗のやり直しとDLQは
 * Embeddingの全断の中で通す。DOの再起動はchat-do.test.ts、つなぎ直した画面の履歴の
 * 取り直しはapps/webのChat.test.tsxが担う
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
	LATCH,
	type MatchQueueMessage,
	PIPELINE,
} from "@latch/shared";
import { eq, inArray, or, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { type Clock, fixedClock, systemClock } from "../src/clock/clock";
import {
	groupCandidates,
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	matchCandidates,
	matchEvents,
	notifications,
	proposalHistory,
	refreshFamilies,
	usageCounters,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import worker from "../src/index";
import { MS_PER_DAY } from "../src/intents/expiry";
import { BREAKER_KEY, recordJevOutcomes } from "../src/jev/breaker";
import { stubEmbedding } from "../src/llm/stub/embedding";
import type { JevFn } from "../src/llm/types";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";
import { evaluateIntent } from "../src/pipeline/evaluate";
import { buildNormalizedText } from "../src/pipeline/normalize";
import { memoryVectorStore } from "../src/vectorstore/memory";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";
import { resetVectorState } from "./reset-vector-state";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 直接呼び出しパターンで固定する現在時刻(docs/04 §4のfixedClock)。JSTでは2026-06-01 09:00 */
const FIXED_NOW = new Date("2026-06-01T00:00:00Z");
const BASE = FIXED_NOW.getTime();
const MIN = 60_000;
const at = (offsetMs: number): Clock => fixedClock(new Date(BASE + offsetMs));

/** テスト鍵の秘密JWK。viteの?rawでフィクスチャ文字列として読む(workerd内からは実FSを読めないため) */
const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

/** 署名鍵を遅延生成する(モジュール評価時に1回だけ) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/** テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud) */
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

/** auth/token→POST /v1/usersで登録済みユーザーを作り、アクセストークンとidを返す */
const registerUser = async (
	label: string,
): Promise<{ accessToken: string; userId: string }> => {
	const tokenRes = await postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
	});
	expect(tokenRes.status).toBe(200);
	const tokenBody = (await tokenRes.json()) as { access_token: string };
	const regRes = await postJson(
		"/v1/users",
		{ display_name: `${label}テスト`, birth_date: "1990-01-01" },
		{ Authorization: `Bearer ${tokenBody.access_token}` },
	);
	expect(regRes.status).toBe(201);
	const regBody = (await regRes.json()) as {
		access_token: string;
		user: { id: string };
	};
	return { accessToken: regBody.access_token, userId: regBody.user.id };
};

/** つながりactiveを作りDTOを返す(POSTの既定status=active・イベントは即時投入) */
const createActiveConnection = async (
	accessToken: string,
	topic: string,
): Promise<IntentDTO> => {
	const res = await postJson(
		"/v1/intents",
		{ raw_text: `${topic}。一緒にやりましょう。`, form: "connection", topic },
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状・pipeline-consumer.test.tsと同一) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/**
 * handleQueueBatchを1件のメッセージで直接呼んで結果(ack/retry)とretryの見張りを返す。
 * attemptsは配信の回数(1始まり・やり直しの遅延の選択に使う)
 */
const runBatch = async (
	queueName: string,
	eventId: string,
	options: { attempts?: number; env?: WorkerEnv; clock?: Clock } = {},
) => {
	const batch = createMessageBatch<MatchQueueMessage>(queueName, [
		{
			id: "msg-0",
			timestamp: FIXED_NOW,
			attempts: options.attempts ?? 1,
			body: { event_id: eventId },
		},
	]);
	const [message] = batch.messages;
	const retrySpy = vi.spyOn(message as Message<MatchQueueMessage>, "retry");
	const ctx = createExecutionContext();
	await handleQueueBatch(
		batch,
		options.env ?? testEnv,
		ctx,
		options.clock ?? at(0),
	);
	return { result: await getQueueResult(batch, ctx), retrySpy };
};

/** 直接INSERT用: users行を1件投入する */
const insertUserRow = async (id: string) => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `degradation-${id}`,
		actorType: "individual",
		displayName: "縮退試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
	});
};

/**
 * intents行の完全なフィクスチャ(既定=つながり・地理なし・active・version=1・1対1だけ)。
 * participants.maxを2にしてグループを組ませない(Jevの枠をグループと分け合わず、
 * 1対1の呼び出し回数を決まった値にするため・docs/06 §3のLayer 4)
 */
const intentFixture = (
	overrides: Partial<typeof intents.$inferSelect> &
		Pick<typeof intents.$inferSelect, "id" | "userId">,
): typeof intents.$inferSelect => ({
	form: "connection",
	topic: "縮退試験の学習仲間",
	category: null,
	rawText: "縮退試験用の入力文",
	startsAt: null,
	endsAt: null,
	geoCenterLat: null,
	geoCenterLng: null,
	geoRadiusM: null,
	participantsMin: 2,
	participantsMax: 2,
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
	jevHeldAt: null,
	jevHeldReason: null,
	jevHeldCount: 0,
	createdAt: FIXED_NOW,
	updatedAt: FIXED_NOW,
	...overrides,
});

/**
 * 利用者と意思の行を入れる。embedded=trueなら埋め込み済み(stubベクトルをupsertし
 * embedded_atを書く・第1段の後の状態)にする。old=trueなら前の日に評価と遅延再評価を
 * 終えた古い意思にする(Cronの未評価の回収(g)・遅延再評価(h)では拾われない)
 */
const seedIntent = async (
	options: { embedded: boolean; old?: boolean } = { embedded: true },
): Promise<typeof intents.$inferSelect> => {
	const userId = ulid();
	await insertUserRow(userId);
	const dayBefore = new Date(BASE - MS_PER_DAY);
	const row = intentFixture({
		id: ulid(),
		userId,
		embeddedAt: options.embedded ? FIXED_NOW : null,
		embeddingModel: options.embedded ? "stub" : null,
		...(options.old === true
			? {
					embeddedAt: dayBefore,
					lastEvaluatedAt: dayBefore,
					delayedReevalAt: dayBefore,
				}
			: {}),
	});
	await db.insert(intents).values(row);
	if (options.embedded) {
		await memoryVectorStore().upsert([
			{
				id: row.id,
				values: await stubEmbedding(buildNormalizedText(row)),
				metadata: {
					form: "connection",
					status: "active",
					category: null,
					user_id: userId,
				},
			},
		]);
	}
	return row;
};

/** intent_createdのイベント行(pending)を入れる(意思の作成の直後の状態) */
const seedCreatedEvent = async (intentId: string): Promise<string> => {
	const eventId = ulid();
	await db.insert(matchEvents).values({
		id: eventId,
		eventType: "intent_created",
		sourceIntentId: intentId,
		version: 1,
		payload: {},
		status: "pending",
		createdAt: FIXED_NOW,
	});
	return eventId;
};

/** 指定Intentのintents行 */
const intentRowOf = async (intentId: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, intentId));
	return row;
};

/** 指定Intentのイベント行 */
const eventsOf = (intentId: string) =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

/** 1対1候補のうち当該Intentをintent_a/bに含む行 */
const candidatesInvolving = (intentId: string) =>
	db
		.select()
		.from(matchCandidates)
		.where(
			or(
				eq(matchCandidates.intentAId, intentId),
				eq(matchCandidates.intentBId, intentId),
			) as SQL,
		);

/** 指定ユーザーが参加するLATCH行の一覧(latch_members経由) */
const latchesOfUser = async (userId: string) => {
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

/** 構造化ログ(console.logの1行JSON)のうち指定イベントのもの */
const logsOf = (
	spy: { mock: { calls: unknown[][] } },
	event: string,
): Record<string, unknown>[] =>
	spy.mock.calls
		.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
		.filter((l) => l.event === event);

beforeEach(async () => {
	await db.delete(notifications);
	await db.delete(latchStatusEvents);
	await db.delete(latchResponses);
	await db.delete(latchMembers);
	await db.delete(proposalHistory);
	await db.delete(latches);
	await db.delete(usageCounters);
	await db.delete(matchEvents);
	await db.delete(matchCandidates);
	await db.delete(groupCandidates);
	await resetVectorState();
	await db.delete(intents);
	await db.delete(refreshFamilies);
	await db.delete(users);
	await testEnv.PIPELINE_KV.delete(BREAKER_KEY);
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Jevの全断(docs/10 §6・docs/06 §5)", () => {
	/** 第一候補も予備も常にtimeout(07 §5)。呼ばれた回数を数える */
	const jevDown = () => {
		const calls = { primary: 0, fallback: 0 };
		const fail =
			(key: keyof typeof calls): JevFn =>
			async () => {
				calls[key] += 1;
				return { ok: false, kind: "timeout" };
			};
		return {
			calls,
			jev: { primary: fail("primary"), fallback: fail("fallback") },
		};
	};

	it("提案化は止まり候補は保留で残り、10連続失敗でcircuit breakerが開いて以後はJevを呼ばない。30分後に閉じると毎分Cronが保留を判定し直して提案が出る", async () => {
		// 同じ主題の古いつながり7件(別々の利用者・前の日に評価と遅延再評価を終えたもの)。
		// どの意思から見ても相手は6件
		const rows = [];
		for (let i = 0; i < 7; i += 1) {
			rows.push(await seedIntent({ embedded: true, old: true }));
		}
		const [a, b1, b2] = rows as [
			(typeof rows)[number],
			(typeof rows)[number],
			(typeof rows)[number],
		];
		const down = jevDown();

		// 1回目の評価: 第一候補6件が失敗→予備へ切り替え、枠8の残り2件も失敗。残り4件は枠切れ
		const r1 = await evaluateIntent(testEnv, a.id, at(0), { jev: down.jev });
		expect(r1).toMatchObject({
			jevCalls: LATCH.JEV_CALLS_PER_EVENT,
			jevHeld: { budget: 0, breaker: 0, failed: 2, cap: 4 },
			proposed: 0,
			held: 0,
		});
		expect(down.calls).toEqual({ primary: 6, fallback: 2 });
		// 候補は保留(candidateのまま・Jevの結果なし)で残り、LATCHも通知も作られない
		const held = await candidatesInvolving(a.id);
		expect(held).toHaveLength(6);
		for (const c of held) {
			expect(c.status).toBe("candidate");
			expect(c.jevResult).toBeNull();
		}
		expect(await db.select().from(latches)).toHaveLength(0);
		expect(await db.select().from(notifications)).toHaveLength(0);

		// 2回目の評価(1分後・別の意思): 第一候補の6件で失敗が通算14件になりbreakerが開く。
		// 次の波(予備への切り替え)の前にbreakerを確かめ、残りは呼ばずに保留する
		const r2 = await evaluateIntent(testEnv, b1.id, at(MIN), { jev: down.jev });
		expect(r2).toMatchObject({
			jevCalls: 6,
			jevHeld: { budget: 0, breaker: 6, failed: 0, cap: 0 },
			proposed: 0,
		});
		const state = await testEnv.PIPELINE_KV.get<{ openUntilMs: number | null }>(
			BREAKER_KEY,
			"json",
		);
		expect(state?.openUntilMs).toBe(BASE + MIN + LATCH.BREAKER_OPEN_MS);

		// 開いている間(2分後)の評価はJevを1回も呼ばずに全件を保留する
		const before = { ...down.calls };
		const r3 = await evaluateIntent(testEnv, b2.id, at(2 * MIN), {
			jev: down.jev,
		});
		expect(r3).toMatchObject({
			jevCalls: 0,
			jevHeld: { budget: 0, breaker: 6, failed: 0, cap: 0 },
			proposed: 0,
		});
		expect(down.calls).toEqual(before);
		expect(await db.select().from(latches)).toHaveLength(0);

		// 保留した3件には保留の印が付く(aは予備も失敗(8件でbreakerは開く前)・b1とb2はbreaker)
		expect((await intentRowOf(a.id))?.jevHeldReason).toBe("failed");
		expect((await intentRowOf(a.id))?.jevHeldCount).toBe(1);
		expect((await intentRowOf(b1.id))?.jevHeldReason).toBe("breaker");
		expect((await intentRowOf(b2.id))?.jevHeldReason).toBe("breaker");

		// 開いている間の毎分Cronは判定し直さない
		await runScheduledPipeline(testEnv, at(3 * MIN));
		expect((await intentRowOf(a.id))?.lastEvaluatedAt).toEqual(FIXED_NOW);
		expect(await db.select().from(latches)).toHaveLength(0);

		// 開いてから30分が過ぎるとbreakerは閉じる。本人の更新も相手側の新しい評価も無いまま、
		// 次の毎分Cron(保留の判定し直し(k)・LAT-105)が保留した3件を評価し直し、Jevが戻った
		// 後の判定で提案が出る(Cronの評価は既定のstubのJevを使う)
		const recovered = new Date(BASE + 2 * MIN + LATCH.BREAKER_OPEN_MS);
		await runScheduledPipeline(testEnv, fixedClock(recovered));
		for (const held of [a, b1, b2]) {
			const row = await intentRowOf(held.id);
			expect(row?.lastEvaluatedAt).toEqual(recovered);
			expect(row?.jevHeldAt).toBeNull();
			// 通知の上限(1Intent同時進行3件)を超えた分は保留のLATCHになる(docs/06 §4)
			const proposed = (await latchesOfUser(held.userId)).filter(
				(l) => l.status === "proposed",
			);
			expect(proposed.length).toBeGreaterThan(0);
		}
		// 判定し直しにも予算とJevの枠(1回の評価で8回)がそのまま効く(1Intent1日40回の内側)
		const counters = await db
			.select()
			.from(usageCounters)
			.where(eq(usageCounters.scope, "jev_intent"));
		const countOf = (id: string) =>
			counters.find((c) => c.key === id)?.count ?? 0;
		expect(countOf(a.id)).toBeLessThanOrEqual(2 * LATCH.JEV_CALLS_PER_EVENT);
		expect(countOf(b1.id)).toBeLessThanOrEqual(6 + LATCH.JEV_CALLS_PER_EVENT);
		// 判定し直しの後の毎分Cronは同じ意思を重ねて評価しない(印が消え、30分の抑制も効く)
		await runScheduledPipeline(
			testEnv,
			fixedClock(new Date(recovered.getTime() + MIN)),
		);
		expect((await intentRowOf(a.id))?.lastEvaluatedAt).toEqual(recovered);
	});

	it("circuit breakerが開いている間も、Parser(構造化)とEmbedding(第1段)は止まらず意思の登録は進む", async () => {
		// 実時間で開いた状態を作る(APIと消費はsystemClockで動く)
		await recordJevOutcomes(
			testEnv.PIPELINE_KV,
			Array.from({ length: LATCH.BREAKER_FAILURES }, () => false),
			systemClock.now(),
		);
		const u1 = await registerUser("degradation-parser-1");
		const u2 = await registerUser("degradation-parser-2");
		const topic = "縮退試験の写真散歩";

		// Parser: 構造化の要求は通常どおり成功する
		const parse = await postJson(
			"/v1/intents/parse",
			{ raw_text: `${topic}。一緒にやりましょう。` },
			{ Authorization: `Bearer ${u1.accessToken}` },
		);
		expect(parse.status).toBe(200);

		// Embedding: 2件とも第1段が済み、検索に載る
		const created: string[] = [];
		for (const u of [u1, u2]) {
			const intent = await createActiveConnection(u.accessToken, topic);
			created.push(intent.id);
			const [event] = await eventsOf(intent.id);
			if (event === undefined) throw new Error("イベント行が無い");
			const { result } = await runBatch("match-events", event.id, {
				clock: systemClock,
			});
			expect(result.retryMessages).toEqual([]);
			expect((await intentRowOf(intent.id))?.embeddedAt).not.toBeNull();
			const [vector] = await memoryVectorStore().getByIds([intent.id]);
			expect(vector).not.toBeNull();
			const events = await eventsOf(intent.id);
			expect(events.find((e) => e.eventType === "intent_created")?.status).toBe(
				"processed",
			);
		}
		// 2件目の評価は1件目を候補に見つけるが、Jevは呼ばずにbreakerの保留にする
		const completed = (await eventsOf(created[1] ?? "")).find(
			(e) => e.eventType === "embedding_completed",
		);
		expect(completed?.payload).toMatchObject({
			jev_calls: 0,
			jev_held: { budget: 0, breaker: 1, failed: 0, cap: 0 },
			proposed: 0,
		});
		expect(await latchesOfUser(u1.userId)).toHaveLength(0);
		expect(await latchesOfUser(u2.userId)).toHaveLength(0);
	});
});

describe("Embeddingの全断とQueues消費の失敗(docs/10 §6・docs/06 §5)", () => {
	/** Workers AIの代わり(LATCH_EMBEDDING_MODE=real)。upがfalseの間は常に例外 */
	const fakeAi = () => {
		const state = { up: false, calls: 0 };
		const run = vi.fn(async (_model: string, input: { text: string[] }) => {
			state.calls += 1;
			if (!state.up) {
				throw new Error("AiError: 試験用のEmbeddingの全断");
			}
			return { data: [await stubEmbedding(input.text[0] ?? "")] };
		});
		const aiEnv = {
			...testEnv,
			LATCH_EMBEDDING_MODE: "real",
			AI: { run },
		} as unknown as WorkerEnv;
		return { state, aiEnv };
	};

	it("やり直し(10秒・30秒・60秒)を使い切るとDLQでdeadになり、全断中は未登録のまま滞留し、復旧後のバックフィルで回収されて提案まで進む", async () => {
		const { state, aiEnv } = fakeAi();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// 相手(埋め込み済み・未評価)と、作成直後で第1段を待つ意思
		const other = await seedIntent();
		const target = await seedIntent({ embedded: false });
		const eventId = await seedCreatedEvent(target.id);

		// 配信1〜3回目は配信の回数に応じた遅延でやり直す。4回目(max_retries=3を超える配信)も
		// やり直しを求め、Queuesがそのメッセージを DLQへ移す
		const delays: (number | undefined)[] = [];
		for (const attempts of [1, 2, 3, 4]) {
			const { result, retrySpy } = await runBatch("match-events", eventId, {
				attempts,
				env: aiEnv,
			});
			expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
			delays.push(retrySpy.mock.calls[0]?.[0]?.delaySeconds);
		}
		expect(delays).toEqual([10, 30, 60, 60]);
		expect((await intentRowOf(target.id))?.embeddedAt).toBeNull();
		expect(logsOf(logSpy, "pipeline.stage1.failed")).toHaveLength(4);
		for (const log of logsOf(logSpy, "pipeline.stage1.failed")) {
			expect(log.layer).toBe("embed");
		}

		// DLQの消費: 起点の行をdeadへ隔離し、警報のログを出す
		await runBatch("match-events-dlq", eventId);
		const [dead] = await eventsOf(target.id);
		expect(dead?.status).toBe("dead");
		expect(logsOf(logSpy, "pipeline.dlq.dead")).toEqual([
			{ level: "warn", event: "pipeline.dlq.dead", count: 1 },
		]);

		// 全断が続く間のCron(作成から5分後): バックフィルも埋め込めず、意思は検索に載らない。
		// 未評価の回収で評価された相手からも見えず、提案は作られない
		const callsBefore = state.calls;
		await runScheduledPipeline(aiEnv, at(PIPELINE.BACKFILL_GRACE_MS));
		expect(state.calls).toBeGreaterThan(callsBefore);
		expect((await intentRowOf(target.id))?.embeddedAt).toBeNull();
		const [missing] = await memoryVectorStore().getByIds([target.id]);
		expect(missing).toBeNull();
		expect((await intentRowOf(other.id))?.lastEvaluatedAt).not.toBeNull();
		expect(await latchesOfUser(target.userId)).toHaveLength(0);

		// 復旧後の次のCron: バックフィルが埋め込み・評価し、相手との提案が出る
		state.up = true;
		const recovered = new Date(BASE + PIPELINE.BACKFILL_GRACE_MS + MIN);
		await runScheduledPipeline(aiEnv, fixedClock(recovered));
		const row = await intentRowOf(target.id);
		expect(row?.embeddedAt).toEqual(recovered);
		expect(row?.lastEvaluatedAt).toEqual(recovered);
		const proposed = await latchesOfUser(target.userId);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.status).toBe("proposed");
		expect((await latchesOfUser(other.userId)).map((l) => l.id)).toEqual(
			proposed.map((l) => l.id),
		);
	});
});

describe("D1の長時間障害(docs/10 §6)", () => {
	/** 常に失敗するD1(文の実行・batch・execがD1_ERRORで失敗する) */
	const brokenD1 = (): D1Database => {
		const fail = () =>
			Promise.reject(new Error("D1_ERROR: 試験用のD1の長時間障害"));
		const statement: Record<string, unknown> = {
			first: fail,
			all: fail,
			run: fail,
			raw: fail,
		};
		statement.bind = () => statement;
		const d1: Record<string, unknown> = {
			prepare: () => statement,
			batch: fail,
			exec: fail,
			dump: fail,
		};
		d1.withSession = () => d1;
		return d1 as unknown as D1Database;
	};
	const downEnv = (): WorkerEnv => ({ ...testEnv, DB: brokenD1() });

	/** 本物のアプリ(index.tsのfetch)を指定のenvで呼ぶ */
	const fetchWith = (
		e: WorkerEnv,
		path: string,
		init: RequestInit = {},
	): Promise<Response> =>
		worker.fetch(
			new Request(`https://localhost${path}`, init),
			e as unknown as Parameters<typeof worker.fetch>[1],
			createExecutionContext(),
		);

	/** エラー応答の1形状(docs/05 §3.1)の500 INTERNALであることを確かめる */
	const expectInternal = async (res: Response) => {
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			error: { code: string; message: string; details: unknown };
		};
		expect(body.error.code).toBe("INTERNAL");
		expect(body.error.details).toEqual({});
		expect(JSON.stringify(body)).not.toContain("D1_ERROR");
	};

	it("APIはD1を使う要求が500 INTERNALの1形状になり、認証済みの利用者を401(サインインし直し)へ倒さない。D1が戻れば同じ要求が通る", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const u = await registerUser("degradation-d1");
		const auth = { Authorization: `Bearer ${u.accessToken}` };
		const e = downEnv();

		await expectInternal(await fetchWith(e, "/v1/intents", { headers: auth }));
		await expectInternal(
			await fetchWith(e, "/v1/latches?type=proposals", { headers: auth }),
		);
		await expectInternal(
			await fetchWith(e, "/v1/intents", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({
					raw_text: "縮退試験の読書会。一緒にやりましょう。",
					form: "connection",
					topic: "縮退試験の読書会",
				}),
			}),
		);
		// サインイン(トークンの発行)もD1を使うため500で、401にはしない
		const signIn = await fetchWith(e, "/v1/auth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "google",
				idp_token: await signIdpToken(`degradation-d1-${crypto.randomUUID()}`),
			}),
		});
		await expectInternal(signIn);
		// D1を使わない死活確認は応答する
		expect((await fetchWith(e, "/healthz")).status).toBe(200);

		// D1が戻れば同じ要求が通る
		expect(
			(await fetchWith(testEnv, "/v1/intents", { headers: auth })).status,
		).toBe(200);
	});

	it("障害中の主キューのメッセージはイベント行の読み取りの失敗でackせず配信の回数に応じた遅延でやり直し、D1が戻った後の再配信で提案まで進む(LAT-104)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const other = await seedIntent();
		const target = await seedIntent({ embedded: false });
		const eventId = await seedCreatedEvent(target.id);
		const e = downEnv();

		// 障害中の配信1〜3回目: イベント行が読めず、10秒・30秒・60秒の遅延でやり直す
		const delays: (number | undefined)[] = [];
		for (const attempts of [1, 2, 3]) {
			const { result, retrySpy } = await runBatch("match-events", eventId, {
				attempts,
				env: e,
			});
			expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
			delays.push(retrySpy.mock.calls[0]?.[0]?.delaySeconds);
		}
		expect(delays).toEqual([10, 30, 60]);
		const failed = logsOf(logSpy, "pipeline.stage1.failed");
		expect(failed).toHaveLength(3);
		for (const log of failed) {
			expect(log.layer).toBe("d1");
			expect(log.intent_id).toBeUndefined();
		}
		const [pending] = await eventsOf(target.id);
		expect(pending?.status).toBe("pending");

		// D1が戻った後の再配信(4回目): 第1段→同じ実行の第2段で、相手との提案が出る
		const { result } = await runBatch("match-events", eventId, {
			attempts: 4,
		});
		expect(result.retryMessages).toEqual([]);
		expect((await intentRowOf(target.id))?.embeddedAt).not.toBeNull();
		const proposed = await latchesOfUser(target.userId);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.status).toBe("proposed");
		expect((await latchesOfUser(other.userId)).map((l) => l.id)).toEqual(
			proposed.map((l) => l.id),
		);
	});

	it("障害がやり直しの回数より長く続くと、主キューのメッセージはやり直しを求め続けてDLQへ移り、D1が戻った後のDLQの消費で起点の行がdeadになる(LAT-104)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const target = await seedIntent({ embedded: false });
		const eventId = await seedCreatedEvent(target.id);
		const e = downEnv();

		// max_retries=3を超える配信(4回目)もやり直しを求め、QueuesがDLQへ移す
		const { result, retrySpy } = await runBatch("match-events", eventId, {
			attempts: 4,
			env: e,
		});
		expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		expect(retrySpy.mock.calls[0]?.[0]?.delaySeconds).toBe(60);

		// DLQの消費(D1が戻った後): 起点の行をdeadへ隔離し、警報のログを出す
		await runBatch("match-events-dlq", eventId);
		const [dead] = await eventsOf(target.id);
		expect(dead?.status).toBe("dead");
		expect(logsOf(logSpy, "pipeline.dlq.dead")).toEqual([
			{ level: "warn", event: "pipeline.dlq.dead", count: 1 },
		]);
	});

	it("障害中のキューの消費・DLQ・Cronは例外を外へ出さず、D1が戻った後のCronが未処理の意思を回収して提案まで進む", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// 障害の直前に作られた2件(第1段を待つ意思と、埋め込み済みで評価を待つ意思)
		const other = await seedIntent();
		const target = await seedIntent({ embedded: false });
		const eventId = await seedCreatedEvent(target.id);
		const e = downEnv();

		// 障害中: 主キュー・DLQの消費とCronは例外を外へ出さない。主キューのメッセージは
		// やり直しを求める(LAT-104)。ここでは、やり直しを使い切って捨てられても毎分Cronの
		// 回収で取り戻せることを確かめる
		const main = await runBatch("match-events", eventId, { env: e });
		expect(main.result.retryMessages).toEqual([{ msgId: "msg-0" }]);
		await expect(
			runBatch("match-events-dlq", eventId, { env: e }),
		).resolves.toBeDefined();
		await expect(
			runScheduledPipeline(e, at(PIPELINE.BACKFILL_GRACE_MS)),
		).resolves.toBeUndefined();
		expect((await intentRowOf(target.id))?.embeddedAt).toBeNull();
		expect(await latchesOfUser(target.userId)).toHaveLength(0);

		// 復旧後の次のCron: バックフィルが埋め込み・評価し、相手との提案が出る
		const recovered = new Date(BASE + PIPELINE.BACKFILL_GRACE_MS + MIN);
		await runScheduledPipeline(testEnv, fixedClock(recovered));
		const row = await intentRowOf(target.id);
		expect(row?.embeddedAt).toEqual(recovered);
		expect(row?.lastEvaluatedAt).toEqual(recovered);
		const proposed = await latchesOfUser(target.userId);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.status).toBe("proposed");
		expect((await latchesOfUser(other.userId)).map((l) => l.id)).toEqual(
			proposed.map((l) => l.id),
		);
	});
});
