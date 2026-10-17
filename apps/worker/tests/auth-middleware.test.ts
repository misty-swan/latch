/**
 * 認証ミドルウェア(requireAuth/requireRegistered/requirePreRegistration)の統合試験。
 * docs/05 §3.1(Authorization: Bearer <JWT>)・docs/04 §4(KV失効リスト・jtiをTTL=残り寿命で格納)。
 * Hono<AppEnv>をテスト内で組み立ててapp.request()で呼ぶ(SELF経由不要・envはcloudflare:testのenv)。
 * テストenvはJWT_SECRET未設定のためjwtSecretはDEV_FALLBACK_JWT_SECRETに倒す(docs/10 §1)。
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AccessClaims, signAccessToken } from "../src/auth/jwt";
import {
	type AppEnv,
	requireAuth,
	requirePreRegistration,
	requireRegistered,
} from "../src/auth/middleware";
import { fixedClock } from "../src/clock/clock";
import { DEV_FALLBACK_JWT_SECRET, type Env } from "../src/env";
import { newUlid } from "../src/ids";

const testEnv = env as unknown as Env;

/** テスト対象のミドルウェアをダミールートに取り付けたアプリ */
const app = new Hono<AppEnv>();
app.get("/t/auth", requireAuth, (c) =>
	c.json({ jti: c.var.auth.jti, exp: c.var.auth.exp }),
);
app.get("/t/registered", requireRegistered, (c) =>
	c.json({ sub: c.var.auth.sub ?? "none" }),
);
app.get("/t/pre", requirePreRegistration, (c) =>
	c.json({
		idpProvider: c.var.auth.idpProvider ?? null,
		idpSubject: c.var.auth.idpSubject ?? null,
	}),
);

/** テスト用の署名鍵(ミドルウェアがjwtSecretで解決する開発/テスト専用フォールバック鍵) */
const SECRET = DEV_FALLBACK_JWT_SECRET;

/** 有効期限内のトークンを作る基準時刻(実現在より未来・joseの実時刻検証で有効と判定される) */
const FUTURE_MS = Date.parse("2030-01-01T00:00:00.000Z");
/** 期限切れトークンを作る基準時刻(実在过去) */
const PAST_MS = Date.parse("2020-01-01T00:00:00.000Z");

const sign = async (
	claims: AccessClaims,
	atMs: number = FUTURE_MS,
	secret: string = SECRET,
): Promise<string> =>
	signAccessToken(secret, fixedClock(new Date(atMs)), claims);

/** 登録済みユーザーのクレーム(subあり) */
const registeredClaims = (
	overrides: Partial<AccessClaims> = {},
): AccessClaims => ({
	jti: crypto.randomUUID(),
	sub: newUlid(),
	idpProvider: "google",
	idpSubject: "idp-subject-1",
	...overrides,
});

/** 登録前JWTのクレーム(sub無し・idpProvider/idpSubjectあり・docs/04 §4・05 §2.3) */
const preRegistrationClaims = (
	overrides: Partial<AccessClaims> = {},
): AccessClaims => ({
	jti: crypto.randomUUID(),
	idpProvider: "google",
	idpSubject: "idp-subject-2",
	...overrides,
});

/** 401応答のbodyをdocs/05 §3.1の形状として取り出す */
const errorBodyOf = async (
	res: Response,
): Promise<{ error: { code: string; message: string; details: unknown } }> =>
	res.json();

describe("requireAuth(docs/05 §3.1: Authorization: Bearer <JWT>必須)", () => {
	it('Authorizationヘッダ無しは401 {error:{code:"UNAUTHORIZED",details:{}}}を返す', async () => {
		const res = await app.request("/t/auth", {}, testEnv);
		expect(res.status).toBe(401);
		const body = await errorBodyOf(res);
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.details).toEqual({});
		expect(body.error.message.length).toBeGreaterThan(0);
	});

	it("「Bearer」以外のスキーマは401 UNAUTHORIZEDを返す", async () => {
		const token = await sign(registeredClaims());
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `Token ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});

	it("スキーマが大文字小文字込みで「Bearer」でない(小文字bearer)場合は401 UNAUTHORIZEDを返す", async () => {
		const token = await sign(registeredClaims());
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});

	it("不正署名(別鍵で署名されたJWT)は401 UNAUTHORIZEDを返す", async () => {
		const token = await sign(
			registeredClaims(),
			FUTURE_MS,
			"another-secret-0123456789abcdef",
		);
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});

	it("期限切れJWTは401 TOKEN_EXPIREDを返す", async () => {
		const token = await sign(registeredClaims(), PAST_MS);
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		const body = await errorBodyOf(res);
		expect(body.error.code).toBe("TOKEN_EXPIRED");
		expect(body.error.details).toEqual({});
	});

	it('有効なJWTは200を返し、c.set("auth")のクレーム(jti・exp)をハンドラで参照できる', async () => {
		const claims = registeredClaims();
		const token = await sign(claims);
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			jti: claims.jti,
			exp: Math.floor(FUTURE_MS / 1000) + 3600,
		});
	});

	it("KVのrevocation:{jti}にjtiがあるJWTは401 UNAUTHORIZEDを返す(docs/04 §4: KV失効リスト)", async () => {
		const claims = registeredClaims();
		const token = await sign(claims);
		// ログアウト等が行う失効登録を直接KVへ書いて模擬する
		await testEnv.REVOCATION_KV.put(`revocation:${claims.jti}`, "1", {
			expirationTtl: 60,
		});
		const res = await app.request(
			"/t/auth",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});
});

describe("requireRegistered(docs/05 §3.1・04 §4: 登録済みユーザーのトークン必須)", () => {
	it("有効な登録済みトークンは200を返しauth.subを返す", async () => {
		const claims = registeredClaims();
		const token = await sign(claims);
		const res = await app.request(
			"/t/registered",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sub: claims.sub });
	});

	it("登録前JWT(sub無し)は401 UNAUTHORIZEDを返す", async () => {
		const token = await sign(preRegistrationClaims());
		const res = await app.request(
			"/t/registered",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});
});

describe("requirePreRegistration(docs/05 §3.1・04 §4: 登録前トークン必須)", () => {
	it("有効な登録前トークンは200を返しidp claims(idpProvider/idpSubject)を返す", async () => {
		const claims = preRegistrationClaims();
		const token = await sign(claims);
		const res = await app.request(
			"/t/pre",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			idpProvider: "google",
			idpSubject: claims.idpSubject,
		});
	});

	it("登録済みJWT(subあり)は401 UNAUTHORIZEDを返す", async () => {
		const token = await sign(registeredClaims());
		const res = await app.request(
			"/t/pre",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});

	it("idpProvider/idpSubjectが欠落したJWTは401 UNAUTHORIZEDを返す", async () => {
		const token = await sign({ jti: crypto.randomUUID() });
		const res = await app.request(
			"/t/pre",
			{ headers: { Authorization: `Bearer ${token}` } },
			testEnv,
		);
		expect(res.status).toBe(401);
		expect((await errorBodyOf(res)).error.code).toBe("UNAUTHORIZED");
	});
});
