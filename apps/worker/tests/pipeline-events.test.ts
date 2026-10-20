/**
 * match_events発行(emitMatchEvent)とIntentルート接続の統合試験。
 * docs/06 §2(作成とdraft→active化は即時投入・更新のみ10秒の遅延配信・resumeは
 * intent_updatedイベントを発行して再評価・UNIQUEが二重投入を許さない)・
 * docs/05 §3.2(Intent API)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通してAPIを叩き、D1の
 * match_events行を直接検証する。MATCH_QUEUEへの送信は
 * vi.spyOn(env.MATCH_QUEUE, "send")で捕捉し、waitUntil内のsend完了を
 * vi.waitUntilで待ってから検査する。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得する
 * (intents-lifecycle-api.test.tsと同一パターン)。
 */

import { env, SELF } from "cloudflare:test";
import {
	type IntentDTO,
	type MatchQueueMessage,
	PIPELINE,
} from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { fixedClock, systemClock } from "../src/clock/clock";
import { matchEvents } from "../src/db/schema";
// ルート・emitMatchEventが受け取るEnv(src/env.ts・生成型Envの宣言部分型)
import type { Env as WorkerEnv } from "../src/env";
import { emitMatchEvent } from "../src/pipeline/events";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** MATCH_QUEUE.sendのモック戻り値(実物と同じ最小形状・QueueSendResponse) */
const sendResponse = (): QueueSendResponse => ({
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
});

/**
 * MATCH_QUEUE.sendを捕捉するモック。呼び出し(メッセージ本体・delaySeconds)だけを
 * 記録し、キューへの実投入は行わない
 */
const spySend = () =>
	vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue(sendResponse());

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

/** ボディ無しPOSTリクエストヘルパー(pause/resumeはボディを受けない) */
const postAction = (path: string, accessToken: string): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
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

/** つながりactiveを作りDTOを返す */
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

/** draft(raw_textのみ)を作りDTOを返す。draftでは発行が起きない */
const createDraft = async (accessToken: string): Promise<IntentDTO> => {
	const res = await postJson(
		"/v1/intents",
		{
			raw_text: "まだぼんやりだけど、いつかサーフィンを始めたい",
			status: "draft",
		},
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** activeのIntentをpauseしDTOを返す(200を試験内で固定) */
const pauseIntent = async (
	accessToken: string,
	intentId: string,
): Promise<IntentDTO> => {
	const res = await postAction(`/v1/intents/${intentId}/pause`, accessToken);
	expect(res.status).toBe(200);
	return (await res.json()) as IntentDTO;
};

/** pausedのIntentをresumeしDTOを返す(200を試験内で固定) */
const resumeIntent = async (
	accessToken: string,
	intentId: string,
): Promise<IntentDTO> => {
	const res = await postAction(`/v1/intents/${intentId}/resume`, accessToken);
	expect(res.status).toBe(200);
	return (await res.json()) as IntentDTO;
};

/** vi.waitUntilのタイムアウト(waitUntil内のINSERT→send完了待ち・CIの遅延を吸収) */
const WAIT = { timeout: 5_000, interval: 20 } as const;

/**
 * 発行「なし」を確かめる試験用の短い待ち。誤って発行する実装がwaitUntil内で
 * 定着するのを猶予する(特定の試験では、この経過後にsend呼び出し0を確かめる)
 */
const flushAsync = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 100));

/** 起点Intentの全イベント行を取得する */
const eventsOf = (
	intentId: string,
): Promise<(typeof matchEvents.$inferSelect)[]> =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

/** 種別で絞ったイベント行を取得する */
const eventsOfType = (
	intentId: string,
	eventType: "intent_created" | "intent_updated",
): Promise<(typeof matchEvents.$inferSelect)[]> =>
	db
		.select()
		.from(matchEvents)
		.where(
			and(
				eq(matchEvents.sourceIntentId, intentId),
				eq(matchEvents.eventType, eventType),
			),
		);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /v1/intentsのイベント発行(docs/06 §2: 作成は即時投入)", () => {
	it("active作成はintent_createdをpendingでINSERTし、即時(第2引数なし)でsendする", async () => {
		const accessToken = await registerUser("emit-create");
		const sendSpy = spySend();
		const created = await createActiveConnection(
			accessToken,
			"走ってつながる学習仲間",
		);
		// waitUntil内のINSERT→sendの完了を待つ
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		// D1のmatch_events行を直接検証
		const rows = await eventsOf(created.id);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.eventType).toBe("intent_created");
		expect(row.version).toBe(1);
		expect(row.status).toBe("pending");
		expect(row.payload).toEqual({});
		expect(row.processedAt).toBeNull();
		// sendは即時(第2引数なし)・メッセージはINSERTした行のevent_id
		expect(sendSpy.mock.calls).toHaveLength(1);
		expect(sendSpy.mock.calls[0].length).toBe(1);
		expect(sendSpy.mock.calls[0][0]).toEqual({
			event_id: row.id,
		} satisfies MatchQueueMessage);
	});

	it("draft作成とdraft編集ではイベント行もsendも発生しない", async () => {
		const accessToken = await registerUser("emit-draft");
		const sendSpy = spySend();
		const draft = await createDraft(accessToken);
		// draftままでの編集(statusはdraftのまま)
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ topic: "draft編集の主題" },
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).status).toBe("draft");
		await flushAsync();
		expect(sendSpy.mock.calls).toHaveLength(0);
		expect(await eventsOf(draft.id)).toHaveLength(0);
	});

	it("draft→active化はintent_createdを発行する(即時・versionは更新後)", async () => {
		const accessToken = await registerUser("emit-activate");
		const sendSpy = spySend();
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active", form: "connection", topic: "active化する学習仲間" },
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).version).toBe(2);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		const rows = await eventsOfType(draft.id, "intent_created");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		// versionはactive化後の値
		expect(row.version).toBe(2);
		expect(row.status).toBe("pending");
		// 即時(第2引数なし)
		expect(sendSpy.mock.calls).toHaveLength(1);
		expect(sendSpy.mock.calls[0].length).toBe(1);
		expect(sendSpy.mock.calls[0][0]).toEqual({ event_id: row.id });
	});

	it("activeのtopic変更はintent_updatedを10秒遅延で発行し、versionは更新後", async () => {
		const accessToken = await registerUser("emit-topic");
		const sendSpy = spySend();
		const created = await createActiveConnection(
			accessToken,
			"更新前の学習仲間",
		);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ topic: "更新後の学習仲間" },
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).version).toBe(2);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 2, WAIT);
		const rows = await eventsOfType(created.id, "intent_updated");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		// versionは更新後の値
		expect(row.version).toBe(2);
		expect(row.status).toBe("pending");
		// sendは遅延10秒(docs/06 §2: 更新のみ10秒の遅延配信)
		expect(sendSpy.mock.calls[1][0]).toEqual({ event_id: row.id });
		expect(sendSpy.mock.calls[1][1]).toEqual({
			delaySeconds: PIPELINE.UPDATE_EVENT_DELAY_SECONDS,
		});
	});

	it("activeのnotification_level変更のみでは行もsendも増えない", async () => {
		const accessToken = await registerUser("emit-notif");
		const sendSpy = spySend();
		const created = await createActiveConnection(
			accessToken,
			"通知だけ変える学習仲間",
		);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ notification_level: "muted" },
			accessToken,
		);
		expect(res.status).toBe(200);
		await flushAsync();
		// 作成時の1件のみ
		expect(sendSpy.mock.calls).toHaveLength(1);
		const rows = await eventsOf(created.id);
		expect(rows).toHaveLength(1);
		expect(rows[0].eventType).toBe("intent_created");
	});

	it("activeのparticipants_includes_owner変更のみでもintent_updatedを発行する(遅延10秒)", async () => {
		const accessToken = await registerUser("emit-includes-owner");
		const sendSpy = spySend();
		// 作成直後のparticipantsは{min:2, max:2, includes_owner:true}(docs/05 §3.2)。
		// min/maxは変えずincludes_ownerだけを切り替えて発行条件を単独で検証する
		const created = await createActiveConnection(
			accessToken,
			"募集形を変える学習仲間",
		);
		expect(created.participants).toEqual({
			min: 2,
			max: 2,
			includes_owner: true,
		});
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ participants: { min: 2, max: 2, includes_owner: false } },
			accessToken,
		);
		expect(res.status).toBe(200);
		const updated = (await res.json()) as IntentDTO;
		expect(updated.version).toBe(2);
		expect(updated.participants).toEqual({
			min: 2,
			max: 2,
			includes_owner: false,
		});
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 2, WAIT);
		const rows = await eventsOfType(created.id, "intent_updated");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		// versionは更新後の値
		expect(row.version).toBe(2);
		expect(row.status).toBe("pending");
		// sendは遅延10秒(docs/06 §2: 更新のみ10秒の遅延配信)
		expect(sendSpy.mock.calls[1][0]).toEqual({ event_id: row.id });
		expect(sendSpy.mock.calls[1][1]).toEqual({
			delaySeconds: PIPELINE.UPDATE_EVENT_DELAY_SECONDS,
		});
	});
});

describe("POST /v1/intents/{id}/pause・resumeのイベント発行(docs/06 §2)", () => {
	it("resumeはintent_updatedを即時(第2引数なし)で発行する・pauseでは発行しない", async () => {
		const accessToken = await registerUser("emit-resume");
		const sendSpy = spySend();
		const created = await createActiveConnection(
			accessToken,
			"再開する学習仲間",
		);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, WAIT);
		const paused = await pauseIntent(accessToken, created.id);
		expect(paused.version).toBe(2);
		// pauseでは発行しない(metadata同期はイベント発行側の別ステップ)
		await flushAsync();
		expect(sendSpy.mock.calls).toHaveLength(1);
		const resumed = await resumeIntent(accessToken, created.id);
		expect(resumed.version).toBe(3);
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 2, WAIT);
		const rows = await eventsOfType(created.id, "intent_updated");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		// versionはresume後の値
		expect(row.version).toBe(3);
		expect(row.status).toBe("pending");
		// 即時(第2引数なし)
		expect(sendSpy.mock.calls).toHaveLength(2);
		expect(sendSpy.mock.calls[1].length).toBe(1);
		expect(sendSpy.mock.calls[1][0]).toEqual({ event_id: row.id });
	});
});

describe("emitMatchEventの冪等性(docs/06 §2: UNIQUEが二重投入を許さない)", () => {
	it("同一(event_type・source_intent_id・version)の再emitは行1行のままでsendだけ2回", async () => {
		const accessToken = await registerUser("emit-idempotent");
		const sendSpy = spySend();
		// draftでは発行が起かないため、FK用のIntent行をdraft作成で用意する
		const draft = await createDraft(accessToken);
		const params = {
			eventType: "intent_created",
			intentId: draft.id,
			version: 1,
		} as const;
		const first = await emitMatchEvent(testEnv, params, undefined, systemClock);
		const second = await emitMatchEvent(
			testEnv,
			params,
			undefined,
			systemClock,
		);
		// 衝突時は既存イベントの再発行のため、戻り値は同一のevent_id
		expect(second).toBe(first);
		const rows = await db
			.select()
			.from(matchEvents)
			.where(
				and(
					eq(matchEvents.sourceIntentId, draft.id),
					eq(matchEvents.eventType, "intent_created"),
					eq(matchEvents.version, 1),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(first);
		// sendは2回(INSERTは1回だけ)
		const calls = sendSpy.mock.calls.filter(
			(call) => (call[0] as MatchQueueMessage).event_id === first,
		);
		expect(calls).toHaveLength(2);
	});
});

describe("emitMatchEventの時刻(docs/04 §4: Clock注入)", () => {
	it("注入したfixedClockの時刻がcreated_atに入る", async () => {
		const accessToken = await registerUser("emit-clock");
		spySend();
		const draft = await createDraft(accessToken);
		const at = new Date("2026-10-19T12:00:00.000Z");
		const eventId = await emitMatchEvent(
			testEnv,
			{ eventType: "intent_created", intentId: draft.id, version: 1 },
			undefined,
			fixedClock(at),
		);
		const [row] = await db
			.select()
			.from(matchEvents)
			.where(eq(matchEvents.id, eventId));
		expect(row?.createdAt.getTime()).toBe(at.getTime());
	});
});
