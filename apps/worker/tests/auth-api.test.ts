/**
 * 認証API(POST /v1/auth/token・/v1/auth/refresh・/v1/auth/logout)の統合試験。
 * docs/05 §3.2(エンドポイント)・§3.1(エラー共通形状)・docs/04 §4(認証・セッション)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * IdPトークンはコミット済みテスト鍵(tests/fixtures/test-idp-private.jwk)で署名し、
 * Worker側はvitest.config.tsが注入するLATCH_TEST_IDP_JWKSバインディングで検証する(docs/04 §4)。
 */

import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { ACCESS_TOKEN_TTL_SECONDS, verifyAccessToken } from "../src/auth/jwt";
import { refreshFamilies, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { newUlid } from "../src/ids";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

/** JWT_SECRETバインディングの値(vitest.config.tsの値と一致させる・docs/10 §1) */
const JWT_SECRET = "unit-test-jwt-secret-0123456789ab";

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
 * expは既定で現在時刻+600秒=有効。負値を渡すと期限切れになる
 */
const signIdpToken = async (
	subject: string,
	expSecondsFromNow = 600,
): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + expSecondsFromNow)
		.sign(await signingKey());
};

/**
 * 登録済みユーザーをenv.DBへ直接INSERTする(docs/05 §2.2のusers必須列)。
 * IdPトークンのsubと一致させるauth_subjectを返す
 */
const insertUser = async (): Promise<{ id: string; authSubject: string }> => {
	const now = new Date();
	const row = {
		id: newUlid(),
		authProvider: "google" as const,
		authSubject: `idp-sub-${crypto.randomUUID()}`,
		actorType: "individual" as const,
		displayName: "統合試験ユーザー",
		bio: "",
		iconKey: null,
		birthDate: "2000-01-01",
		status: "active" as const,
		createdAt: now,
		updatedAt: now,
	};
	await db.insert(users).values(row);
	return { id: row.id, authSubject: row.authSubject };
};

/** JSONボディのPOSTヘルパー */
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

/** POST /v1/auth/tokenを呼ぶ(IdPトークンは都度署名する・expSecondsFromNowは既定で有効) */
const postToken = async (
	subject: string,
	expSecondsFromNow = 600,
): Promise<Response> =>
	postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(subject, expSecondsFromNow),
	});

/** docs/05 §3.2のtoken成功応答の形状 */
interface TokenResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
	user: {
		id: string;
		display_name: string;
		bio: string;
		has_icon: boolean;
	} | null;
	registration_required: boolean;
}

/** docs/05 §3.1のエラー応答の形状 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

describe("POST /v1/auth/token(docs/05 §3.2: IdPトークン検証+JWT発行)", () => {
	it("未登録のIdPトークンは200・registration_required=true・user=null・refresh_token=nullの登録前JWTを返す", async () => {
		const res = await postToken(`unregistered-${crypto.randomUUID()}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TokenResponse;
		expect(body.registration_required).toBe(true);
		expect(body.user).toBeNull();
		expect(body.refresh_token).toBeNull();
		expect(body.access_token.length).toBeGreaterThan(0);
		expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
		// 登録前JWT: sub無し・idp claims付き(docs/04 §4・05 §2.3)
		const claims = await verifyAccessToken(JWT_SECRET, body.access_token);
		expect(claims.sub).toBeUndefined();
		expect(claims.idpProvider).toBe("google");
	});

	it("登録済みユーザーは200・registration_required=false・UserDTO(has_icon=false)・refresh_tokenありのsub付きJWTを返す", async () => {
		const { id, authSubject } = await insertUser();
		const res = await postToken(authSubject);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TokenResponse;
		expect(body.registration_required).toBe(false);
		expect(body.user).toEqual({
			id,
			display_name: "統合試験ユーザー",
			bio: "",
			has_icon: false,
		});
		expect(typeof body.refresh_token).toBe("string");
		const claims = await verifyAccessToken(JWT_SECRET, body.access_token ?? "");
		expect(claims.sub).toBe(id);
	});

	it("同一ユーザーの再ログインは既存族を再利用せずリフレッシュ族を都度新設する(docs/04 §4: 族=ログインセッション単位)", async () => {
		const { id, authSubject } = await insertUser();
		const res1 = await postToken(authSubject);
		const body1 = (await res1.json()) as TokenResponse;
		const res2 = await postToken(authSubject);
		const body2 = (await res2.json()) as TokenResponse;
		expect(res1.status).toBe(200);
		expect(res2.status).toBe(200);
		expect(body1.refresh_token).not.toBe(body2.refresh_token);
		const families = await db
			.select()
			.from(refreshFamilies)
			.where(eq(refreshFamilies.userId, id));
		expect(families).toHaveLength(2);
		expect(families.map((f) => f.status)).toEqual(["active", "active"]);
	});

	it("期限切れのIdPトークンは401 UNAUTHORIZED(共通エラー形状・内部詳細を漏らさない)", async () => {
		const res = await postToken(`expired-${crypto.randomUUID()}`, -3600);
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.details).toEqual({});
		expect(body.error.message.length).toBeGreaterThan(0);
		// joseの理由(ERR_JWT_EXPIRED等)をエラー応答へ漏らさない
		expect(body.error.message).not.toContain("ERR_JWT_EXPIRED");
	});

	it("provider欠落は400 VALIDATION_FAILED(リクエスト検証)", async () => {
		const res = await postJson("/v1/auth/token", { idp_token: "dummy" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details).toEqual({});
	});
});

describe("POST /v1/auth/refresh(docs/05 §3.2・04 §4: 回転式)", () => {
	it("token→refreshでaccess_tokenとrefresh_tokenが更新され、旧refreshは猶予により1回再提示できる", async () => {
		const { id, authSubject } = await insertUser();
		const tokenRes = await postToken(authSubject);
		const tokenBody = (await tokenRes.json()) as TokenResponse;

		// 1回目の回転: access_token・refresh_tokenとも更新される
		const res1 = await postJson("/v1/auth/refresh", {
			refresh_token: tokenBody.refresh_token,
		});
		expect(res1.status).toBe(200);
		const body1 = (await res1.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};
		expect(body1.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
		expect(body1.access_token).not.toBe(tokenBody.access_token);
		expect(body1.refresh_token).not.toBe(tokenBody.refresh_token);
		// 回転後のアクセストークンは登録済みJWT(sub付き)
		const claims = await verifyAccessToken(JWT_SECRET, body1.access_token);
		expect(claims.sub).toBe(id);

		// 猶予: 直後の旧トークン再提示は1回だけ成功し、現行トークンが再返却される(docs/04 §4)
		const res2 = await postJson("/v1/auth/refresh", {
			refresh_token: tokenBody.refresh_token,
		});
		expect(res2.status).toBe(200);
		const body2 = (await res2.json()) as typeof body1;
		expect(body2.refresh_token).toBe(body1.refresh_token);

		// 現行トークンでの回転は引き続き成功する(族は失効していない)
		const res3 = await postJson("/v1/auth/refresh", {
			refresh_token: body1.refresh_token,
		});
		expect(res3.status).toBe(200);
	});

	it("未知のrefresh_tokenは401 UNAUTHORIZED", async () => {
		const res = await postJson("/v1/auth/refresh", {
			refresh_token: `unknown-${crypto.randomUUID()}`,
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.details).toEqual({});
	});
});

describe("POST /v1/auth/logout(docs/05 §3.2・04 §4: JWT失効(KV)+族失効)", () => {
	it("204(空ボディ)を返し、bodyのrefresh_tokenの族がrevokedになり、同一access_tokenの再呼び出しは401になる", async () => {
		const { id, authSubject } = await insertUser();
		const tokenRes = await postToken(authSubject);
		const tokenBody = (await tokenRes.json()) as TokenResponse;

		const res = await postJson(
			"/v1/auth/logout",
			{ refresh_token: tokenBody.refresh_token },
			{ Authorization: `Bearer ${tokenBody.access_token}` },
		);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");

		// 族がrevokedになる(D1直接確認・docs/04 §4)
		const families = await db
			.select()
			.from(refreshFamilies)
			.where(eq(refreshFamilies.userId, id));
		expect(families).toHaveLength(1);
		expect(families[0]?.status).toBe("revoked");

		// 同一access_tokenでの再呼び出しは401(KV失効・docs/04 §4)
		const res2 = await postJson(
			"/v1/auth/logout",
			{},
			{ Authorization: `Bearer ${tokenBody.access_token}` },
		);
		expect(res2.status).toBe(401);
		const errorBody = (await res2.json()) as ErrorResponse;
		expect(errorBody.error.code).toBe("UNAUTHORIZED");
	});

	it("refresh_token無しのlogoutも204(KV失効のみ)", async () => {
		const { authSubject } = await insertUser();
		const tokenRes = await postToken(authSubject);
		const tokenBody = (await tokenRes.json()) as TokenResponse;
		const res = await postJson(
			"/v1/auth/logout",
			{},
			{ Authorization: `Bearer ${tokenBody.access_token}` },
		);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	});
});
