/**
 * 意思を有効にした要求の応答の後の第1段・第2段の統合試験(#30・オーナー決定3b・
 * 不具合の修正工程(第3回)の設計 §3.5)。
 * activeでの作成・下書きの有効化の応答の後(waitUntil)に、キューの1メッセージの処理と
 * 同じ処理(intent_createdの行の消費→第1段→同じ実行の第2段→提案の通知の送出)を行う。
 * キューのintent_createdのメッセージはPIPELINE.INLINE_FALLBACK_DELAY_S(60秒)遅らせて送り、
 * 応答の後の処理が済んでいれば何もせずに終わる(やり直しの役)。
 * 試験の設定(vitest.config.ts)はLATCH_INLINE_PIPELINE=offのため、ここだけenvを差し替えて
 * onで確かめる。入口(default export)を直接呼び、waitOnExecutionContextで応答の後の処理の
 * 完了まで待つ。
 */
import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
	waitOnExecutionContext,
} from "cloudflare:test";
import {
	type IntentDTO,
	type MatchQueueMessage,
	PIPELINE,
} from "@latch/shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { systemClock } from "../src/clock/clock";
import { intents, matchEvents, notifications } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import worker from "../src/index";
import { handleQueueBatch } from "../src/pipeline/consumer";
import { memoryVectorStore } from "../src/vectorstore/memory";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";
import { resetVectorState } from "./reset-vector-state";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 応答の後の処理を行う環境(試験の既定はoff) */
const inlineEnv = (overrides: Partial<WorkerEnv> = {}): WorkerEnv =>
	({
		...testEnv,
		LATCH_INLINE_PIPELINE: "on",
		...overrides,
	}) as WorkerEnv;

const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign((await importJWK(privateJwk, "RS256")) as CryptoKey);
};

/** 入口(default export)を直接呼び、waitUntilの完了まで待つ */
const fetchAndWait = async (
	method: string,
	path: string,
	token: string | undefined,
	body: unknown,
	targetEnv: WorkerEnv,
): Promise<Response> => {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://localhost${path}`, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		targetEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
};

interface Account {
	token: string;
	id: string;
}

const registerUser = async (label: string): Promise<Account> => {
	const tokenRes = await fetchAndWait(
		"POST",
		"/v1/auth/token",
		undefined,
		{
			provider: "google",
			idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
		},
		testEnv,
	);
	const pre = (await tokenRes.json()) as { access_token: string };
	const regRes = await fetchAndWait(
		"POST",
		"/v1/users",
		pre.access_token,
		{ display_name: `${label}さん`, birth_date: "1990-01-01" },
		testEnv,
	);
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { token: body.access_token, id: body.user.id };
};

/** activeのつながりIntentを作る(応答の後の処理の完了まで待つ) */
const createActive = (
	account: Account,
	topic: string,
	targetEnv: WorkerEnv,
): Promise<Response> =>
	fetchAndWait(
		"POST",
		"/v1/intents",
		account.token,
		{ raw_text: `${topic}。一緒にやりましょう。`, form: "connection", topic },
		targetEnv,
	);

/** MATCH_QUEUE.sendを捕捉するモック。実キューへの投入は行わない */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
	});

const eventsOf = (intentId: string) =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

const eventOfType = async (
	intentId: string,
	eventType: "intent_created" | "embedding_completed" | "vector_reflection",
) =>
	(
		await db
			.select()
			.from(matchEvents)
			.where(
				and(
					eq(matchEvents.sourceIntentId, intentId),
					eq(matchEvents.eventType, eventType),
				),
			)
	)[0];

/** 遅れて届いたキューのメッセージを、handleQueueBatchで消費する */
const consumeLater = async (eventId: string, attempts = 1) => {
	const batch = createMessageBatch<MatchQueueMessage>("match-events", [
		{
			id: "late",
			timestamp: new Date(),
			attempts,
			body: { event_id: eventId },
		},
	]);
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, testEnv, ctx, systemClock);
	await waitOnExecutionContext(ctx);
	return getQueueResult(batch, ctx);
};

const logsOf = (
	spy: ReturnType<typeof vi.spyOn>,
	event: string,
): Record<string, unknown>[] =>
	spy.mock.calls
		.map((call: unknown[]) => {
			try {
				return JSON.parse(String(call[0])) as Record<string, unknown>;
			} catch {
				return {} as Record<string, unknown>;
			}
		})
		.filter((line: Record<string, unknown>) => line.event === event);

beforeEach(async () => {
	await resetVectorState();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("activeでの作成の応答の後の第1段・第2段(#30・設計 §3.5)", () => {
	it("応答(201)の後に、intent_createdとembedding_completedがprocessedになり、反映確認の行ができる", async () => {
		const a = await registerUser("即甲");
		const send = spySend();

		const res = await createActive(a, "応答の後の学習仲間", inlineEnv());
		expect(res.status).toBe(201);
		const created = (await res.json()) as IntentDTO;

		const origin = await eventOfType(created.id, "intent_created");
		expect(origin?.status).toBe("processed");
		// 応答の後の処理で済んだ印(D1から経路の内訳を集計するため)
		expect(origin?.payload).toEqual({ path: "inline" });
		const completed = await eventOfType(created.id, "embedding_completed");
		expect(completed?.status).toBe("processed");
		expect(completed?.payload).toHaveProperty("retrieval_count");
		const reflection = await eventOfType(created.id, "vector_reflection");
		expect(reflection?.status).toBe("pending");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.embeddedAt).not.toBeNull();

		// intent_createdのメッセージは60秒遅らせて送る(やり直しの役)
		expect(PIPELINE.INLINE_FALLBACK_DELAY_S).toBe(60);
		expect(send.mock.calls).toContainEqual([
			{ event_id: origin?.id },
			{ delaySeconds: PIPELINE.INLINE_FALLBACK_DELAY_S },
		]);
		expect(send.mock.calls).toContainEqual([
			{ event_id: reflection?.id },
			{ delaySeconds: PIPELINE.REFLECTION_DELAYS_S[0] },
		]);
		// embedding_completedはキューへ送らない(同じ実行で第2段を続けた)
		expect(
			send.mock.calls.some(
				(call) => (call[0] as MatchQueueMessage).event_id === completed?.id,
			),
		).toBe(false);
	});

	it("遅れて届いたintent_createdのメッセージは、第1段も第2段も繰り返さない", async () => {
		const a = await registerUser("即乙");
		spySend();
		const res = await createActive(a, "繰り返さない学習仲間", inlineEnv());
		const created = (await res.json()) as IntentDTO;
		const origin = await eventOfType(created.id, "intent_created");
		const before = await eventsOf(created.id);
		const [rowBefore] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));

		const store = memoryVectorStore();
		const upsert = vi.spyOn(store, "upsert");
		const query = vi.spyOn(store, "query");
		const result = await consumeLater(origin?.id ?? "");

		expect(result.retryMessages).toEqual([]);
		expect(upsert).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
		const after = await eventsOf(created.id);
		expect(after).toHaveLength(before.length);
		const [rowAfter] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(rowAfter?.embeddedAt?.getTime()).toBe(
			rowBefore?.embeddedAt?.getTime(),
		);
		expect(rowAfter?.lastEvaluatedAt?.getTime()).toBe(
			rowBefore?.lastEvaluatedAt?.getTime(),
		);
	});

	it("第1段が失敗(やり直し)したら行はpendingのまま残り、遅れたメッセージの消費でやり直される", async () => {
		const a = await registerUser("即丙");
		spySend();
		const store = memoryVectorStore();
		const upsert = vi
			.spyOn(store, "upsert")
			.mockRejectedValueOnce(new Error("試験用のupsertの失敗"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const res = await createActive(a, "やり直す学習仲間", inlineEnv());
		expect(res.status).toBe(201);
		const created = (await res.json()) as IntentDTO;
		const origin = await eventOfType(created.id, "intent_created");
		expect(origin?.status).toBe("pending");
		expect(
			await eventOfType(created.id, "embedding_completed"),
		).toBeUndefined();
		// やり直しは失敗ではない(inline.failedは出さない)
		expect(logsOf(logSpy, "pipeline.inline.failed")).toHaveLength(0);

		upsert.mockRestore();
		const result = await consumeLater(origin?.id ?? "");
		expect(result.retryMessages).toEqual([]);
		const retried = await eventOfType(created.id, "intent_created");
		expect(retried?.status).toBe("processed");
		// キューのやり直しで済んだ行はpath=queue
		expect(retried?.payload).toEqual({ path: "queue" });
		expect((await eventOfType(created.id, "embedding_completed"))?.status).toBe(
			"processed",
		);
	});

	it("応答の後の処理の第1段の完了ログはlayer=inline", async () => {
		const a = await registerUser("即壬");
		spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const res = await createActive(a, "経路の印の学習仲間", inlineEnv());
		expect(res.status).toBe(201);

		const completed = logsOf(logSpy, "pipeline.stage1.completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]?.layer).toBe("inline");
	});

	it("応答の後の処理が例外を投げても応答は201のまま、pipeline.inline.failedが出る", async () => {
		const a = await registerUser("即丁");
		spySend();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// 起点の行をprocessedへ倒す更新だけを失敗させる(第1段の後の例外)。
		// intent_createdは経路の印(payload)と一緒にstatusを書く
		const failingDb = new Proxy(testEnv.DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (query: string) => {
						if (
							/^update "match_events" set ("payload" = \?, )?"status"/i.test(
								query,
							)
						) {
							throw new Error("forced");
						}
						return target.prepare(query);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const res = await createActive(
			a,
			"例外の学習仲間",
			inlineEnv({ DB: failingDb }),
		);
		expect(res.status).toBe(201);
		const created = (await res.json()) as IntentDTO;
		expect(logsOf(logSpy, "pipeline.inline.failed")).toEqual([
			expect.objectContaining({ intent_id: created.id }),
		]);
		// 行はpendingのまま(遅れたメッセージがやり直す)
		expect((await eventOfType(created.id, "intent_created"))?.status).toBe(
			"pending",
		);
	});

	it("提案ができたら、その通知は応答の後の処理の中で送出の対象になる", async () => {
		const a = await registerUser("即戊");
		const b = await registerUser("即己");
		spySend();
		const topic = "応答の後に提案する山歩き仲間";
		const first = await createActive(a, topic, inlineEnv());
		expect(first.status).toBe(201);
		// 入口の送出(pushFlushAfterWrite)が先に終わるよう、評価の照会を少し遅らせる
		// (ここで作られる通知を送るのは応答の後の処理の送出だけになる)
		const store = memoryVectorStore();
		const original = store.query.bind(store);
		vi.spyOn(store, "query").mockImplementation(async (values, options) => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return original(values, options);
		});

		const second = await createActive(b, topic, inlineEnv());
		expect(second.status).toBe(201);

		const rows = await db
			.select({
				state: notifications.pushState,
				type: notifications.type,
			})
			.from(notifications)
			.where(inArray(notifications.userId, [a.id, b.id]));
		const proposals = rows.filter((r) => r.type === "proposal");
		expect(proposals.length).toBeGreaterThan(0);
		// 購読が無いのでno_subscription(送出の対象になった印)。pendingは残らない
		expect(proposals.map((r) => r.state)).not.toContain("pending");
	});
});

describe("下書きの有効化の応答の後の第1段・第2段(#30・設計 §3.5)", () => {
	it("有効化の応答(200)の後に、intent_createdとembedding_completedがprocessedになり、メッセージは60秒遅れ", async () => {
		const a = await registerUser("即庚");
		const send = spySend();
		const draftRes = await fetchAndWait(
			"POST",
			"/v1/intents",
			a.token,
			{ raw_text: "いつか一緒に走りたい", status: "draft" },
			inlineEnv(),
		);
		expect(draftRes.status).toBe(201);
		const draft = (await draftRes.json()) as IntentDTO;
		expect(await eventsOf(draft.id)).toHaveLength(0);

		const res = await fetchAndWait(
			"PATCH",
			`/v1/intents/${draft.id}`,
			a.token,
			{ status: "active", form: "connection", topic: "有効化する走る仲間" },
			inlineEnv(),
		);
		expect(res.status).toBe(200);
		const origin = await eventOfType(draft.id, "intent_created");
		expect(origin?.version).toBe(2);
		expect(origin?.status).toBe("processed");
		expect((await eventOfType(draft.id, "embedding_completed"))?.status).toBe(
			"processed",
		);
		expect(send.mock.calls).toContainEqual([
			{ event_id: origin?.id },
			{ delaySeconds: PIPELINE.INLINE_FALLBACK_DELAY_S },
		]);
	});
});

describe("LATCH_INLINE_PIPELINE=offは今と同じ", () => {
	it("intent_createdのメッセージは即時で送り、応答の後の処理は行わない", async () => {
		const a = await registerUser("即辛");
		const send = spySend();
		const res = await createActive(a, "今と同じ学習仲間", testEnv);
		expect(res.status).toBe(201);
		const created = (await res.json()) as IntentDTO;
		const origin = await eventOfType(created.id, "intent_created");
		expect(origin?.status).toBe("pending");
		expect(
			await eventOfType(created.id, "embedding_completed"),
		).toBeUndefined();
		expect(send.mock.calls).toEqual([[{ event_id: origin?.id }]]);
	});
});
