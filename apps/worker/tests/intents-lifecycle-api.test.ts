/**
 * Intent API(一時停止pause・再開resume)の統合試験。
 * docs/05 §3.2(POST /v1/intents/{id}/pause・resume)・§3.1(ACTIVE_INTENT_LIMIT=422・
 * 他人のIntentは存在を隠すため一律404)。pauseはactiveのみ・resumeはpausedのみで、
 * resumeはactive化と同じActive Intent上限(5件)の検証を受ける
 * (作成・draft→active化・resumeの3経路で一貫・docs/05 §3.1)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得する
 * (intents-crud-api.test.tsと同一パターン)。
 */

import { env, SELF } from "cloudflare:test";
import type { IntentDTO } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { intents } from "../src/db/schema";
import { MS_PER_DAY } from "../src/intents/expiry";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

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

/** ボディ無しPOSTリクエストヘルパー(pause/resumeはボディを受けない) */
const postAction = (path: string, accessToken: string): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
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

/** docs/05 §3.1のエラー応答の形状(details.reasonsに理由コードを載せる場合がある) */
interface ErrorResponse {
	error: { code: string; message: string; details: { reasons?: string[] } };
}

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

/** draft(raw_textのみ)を作りDTOを返す */
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

describe("POST /v1/intents/{id}/pause(一時停止・docs/05 §3.2)", () => {
	it("activeのpauseは200・status=paused・version+1・expires_atは据え置き", async () => {
		const accessToken = await registerUser("pause-active");
		const created = await createActiveConnection(
			accessToken,
			"一時停止する学習仲間",
		);
		const before = created.expires_at;
		const body = await pauseIntent(accessToken, created.id);
		expect(body.id).toBe(created.id);
		expect(body.status).toBe("paused");
		// version+1(docs/01 §16)
		expect(body.version).toBe(created.version + 1);
		expect(body.topic).toBe("一時停止する学習仲間");
		// pauseは期限を変更しない
		expect(body.expires_at).toBe(before);
		// DB行もpausedになっている
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("paused");
		expect(row?.version).toBe(2);
	});

	it("draftへのpauseは400 VALIDATION_FAILED・details.reasonsにinvalid_status・行不変", async () => {
		const accessToken = await registerUser("pause-draft");
		const draft = await createDraft(accessToken);
		const res = await postAction(`/v1/intents/${draft.id}/pause`, accessToken);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["invalid_status"]);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, draft.id));
		expect(row?.status).toBe("draft");
		expect(row?.version).toBe(1);
	});

	it("二重pause(pausedへの再pause)は400・details.reasonsにinvalid_status・version据え置き", async () => {
		const accessToken = await registerUser("pause-twice");
		const created = await createActiveConnection(
			accessToken,
			"二重停止の学習仲間",
		);
		const paused = await pauseIntent(accessToken, created.id);
		expect(paused.status).toBe("paused");
		const res = await postAction(
			`/v1/intents/${created.id}/pause`,
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["invalid_status"]);
		// 2回目のpauseでversionは進まない
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("paused");
		expect(row?.version).toBe(2);
	});

	it("他人のIntentへのpauseは404・行は不変(存在を隠す)。存在しないidも404", async () => {
		const owner = await registerUser("pause-owner");
		const other = await registerUser("pause-other");
		const created = await createActiveConnection(
			owner,
			"他人は止められない学習仲間",
		);
		const res = await postAction(`/v1/intents/${created.id}/pause`, other);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("active");
		expect(row?.version).toBe(1);
		// 存在しないidも同じ404
		const missing = await postAction(`/v1/intents/${ulid()}/pause`, owner);
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as ErrorResponse).error.code).toBe(
			"NOT_FOUND",
		);
	});

	it("未認証のpauseは401 UNAUTHORIZED", async () => {
		const res = await SELF.fetch(
			`https://localhost/v1/intents/${ulid()}/pause`,
			{
				method: "POST",
			},
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("POST /v1/intents/{id}/resume(再開・docs/05 §3.2)", () => {
	it("pausedのresumeは200・status=active・version+1・expires_atは据え置き", async () => {
		const accessToken = await registerUser("resume-paused");
		const created = await createActiveConnection(
			accessToken,
			"再開する学習仲間",
		);
		const paused = await pauseIntent(accessToken, created.id);
		const res = await postAction(
			`/v1/intents/${created.id}/resume`,
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.id).toBe(created.id);
		expect(body.status).toBe("active");
		// pause(version+1)→resume(さらにversion+1)
		expect(body.version).toBe(paused.version + 1);
		// resumeは期限を再計算しない(据え置き)
		expect(body.expires_at).toBe(paused.expires_at);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("active");
		expect(row?.version).toBe(3);
	});

	it("paused以外へのresumeは400・details.reasonsにinvalid_status(active・draftとも)", async () => {
		const accessToken = await registerUser("resume-non-paused");
		const active = await createActiveConnection(
			accessToken,
			"停止していない学習仲間",
		);
		const resActive = await postAction(
			`/v1/intents/${active.id}/resume`,
			accessToken,
		);
		expect(resActive.status).toBe(400);
		const bodyActive = (await resActive.json()) as ErrorResponse;
		expect(bodyActive.error.details.reasons).toEqual(["invalid_status"]);
		const draft = await createDraft(accessToken);
		const resDraft = await postAction(
			`/v1/intents/${draft.id}/resume`,
			accessToken,
		);
		expect(resDraft.status).toBe(400);
		const bodyDraft = (await resDraft.json()) as ErrorResponse;
		expect(bodyDraft.error.details.reasons).toEqual(["invalid_status"]);
	});

	it("expires_atが過去の行のresumeは400・details.reasonsにexpired・行はpausedのまま", async () => {
		const accessToken = await registerUser("resume-expired");
		const created = await createActiveConnection(
			accessToken,
			"期限が過ぎた学習仲間",
		);
		const paused = await pauseIntent(accessToken, created.id);
		// 期限切れへの遷移自体はF3のCronが行うため、試験では直接UPDATEで過去にする
		await db
			.update(intents)
			.set({ expiresAt: new Date(Date.now() - MS_PER_DAY) })
			.where(eq(intents.id, created.id));
		const res = await postAction(
			`/v1/intents/${created.id}/resume`,
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["expired"]);
		// 行はpaused・version据え置き(expired遷移はCronの仕事)
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("paused");
		expect(row?.version).toBe(paused.version);
	});

	it("resumeでactiveが5件既存なら422 ACTIVE_INTENT_LIMIT・pausedはpausedのまま", async () => {
		const accessToken = await registerUser("resume-limit");
		const pausedTarget = await createActiveConnection(
			accessToken,
			"一時停止しておく学習仲間",
		);
		const paused = await pauseIntent(accessToken, pausedTarget.id);
		// paused1件と別にactiveを5件作る(上限まで)
		for (let i = 0; i < 5; i++) {
			await createActiveConnection(accessToken, `参加中の学習仲間その${i + 1}`);
		}
		const res = await postAction(
			`/v1/intents/${pausedTarget.id}/resume`,
			accessToken,
		);
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("ACTIVE_INTENT_LIMIT");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, pausedTarget.id));
		expect(row?.status).toBe("paused");
		expect(row?.version).toBe(paused.version);
	});

	it("他人のpaused Intentへのresumeは404・行は不変(存在を隠す)。存在しないidも404", async () => {
		const owner = await registerUser("resume-owner");
		const other = await registerUser("resume-other");
		const created = await createActiveConnection(
			owner,
			"他人は再開できない学習仲間",
		);
		await pauseIntent(owner, created.id);
		const res = await postAction(`/v1/intents/${created.id}/resume`, other);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.status).toBe("paused");
		// 存在しないidも同じ404
		const missing = await postAction(`/v1/intents/${ulid()}/resume`, owner);
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as ErrorResponse).error.code).toBe(
			"NOT_FOUND",
		);
	});
});

describe("ACTIVE_INTENT_LIMITの3経路一貫性(docs/05 §3.1)", () => {
	it("上限到達時は作成・draft→active化・resumeの3経路すべて422", async () => {
		const accessToken = await registerUser("limit-3paths");
		// 1件を先にpauseしておく(後でresume経路の422に使う)
		const pausedTarget = await createActiveConnection(
			accessToken,
			"先に止めておく学習仲間",
		);
		await pauseIntent(accessToken, pausedTarget.id);
		// activeを5件作る(上限まで)
		for (let i = 0; i < 5; i++) {
			await createActiveConnection(accessToken, `参加中の学習仲間その${i + 1}`);
		}
		// 経路1: 6件目のactive作成は422
		const createRes = await postJson(
			"/v1/intents",
			{
				raw_text: "6件目。一緒にやりましょう。",
				form: "connection",
				topic: "6件目の学習仲間",
			},
			{ Authorization: `Bearer ${accessToken}` },
		);
		expect(createRes.status).toBe(422);
		expect(((await createRes.json()) as ErrorResponse).error.code).toBe(
			"ACTIVE_INTENT_LIMIT",
		);
		// 経路2: draft→active化(PATCH)も422
		const draft = await createDraft(accessToken);
		const patchRes = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active", form: "connection", topic: "active化の学習仲間" },
			accessToken,
		);
		expect(patchRes.status).toBe(422);
		expect(((await patchRes.json()) as ErrorResponse).error.code).toBe(
			"ACTIVE_INTENT_LIMIT",
		);
		// 経路3: paused→resumeも422
		const resumeRes = await postAction(
			`/v1/intents/${pausedTarget.id}/resume`,
			accessToken,
		);
		expect(resumeRes.status).toBe(422);
		expect(((await resumeRes.json()) as ErrorResponse).error.code).toBe(
			"ACTIVE_INTENT_LIMIT",
		);
	});
});
