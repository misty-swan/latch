/**
 * ユーザーAPI(POST /v1/users・GET/PATCH /v1/users/me)の統合試験。
 * docs/05 §3.2(エンドポイント)・§3.1(エラー共通形状)・§2.5(削除は行を残す)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * 登録前JWTは実フロー(auth/tokenでIdPトークン検証)経由で取得する。
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

/**
 * 「JSTの今日からyears年前・dayShift日ずらし」の誕生日('YYYY-MM-DD')を作る。
 * 統合試験はsystemClock(実時間)で動くため、現在日からの相対値で18歳/17歳を作る。
 * ずらし後の月末日・2/29はDate.UTCが正規化するため常に実在日になる
 */
const birthDateYearsAgo = (years: number, dayShift: number): string => {
	const jstNow = new Date(Date.now() + JST_OFFSET_MS);
	return new Date(
		Date.UTC(
			jstNow.getUTCFullYear() - years,
			jstNow.getUTCMonth(),
			jstNow.getUTCDate() + dayShift,
		),
	)
		.toISOString()
		.slice(0, 10);
};

/** JSONボディのリクエストヘルパー */
const requestJson = (
	method: string,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

const postJson = (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> => requestJson("POST", path, body, headers);

/** docs/05 §3.1のエラー応答の形状 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

/** UserDTOの形状(docs/05 §3.3) */
interface UserDtoShape {
	id: string;
	display_name: string;
	bio: string;
	has_icon: boolean;
}

/** POST /v1/usersの201応答の形状 */
interface RegisterResponse {
	user: UserDtoShape;
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/**
 * auth/tokenで登録前JWT(sub無し)を取得する実フロー(docs/05 §3.2)。
 * subjectのusers行が未登録である前提
 */
const getPreRegistrationToken = async (subject: string): Promise<string> => {
	const res = await postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(subject),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		access_token: string;
		registration_required: boolean;
	};
	expect(body.registration_required).toBe(true);
	return body.access_token;
};

/** POST /v1/usersを呼ぶ */
const postUsers = (
	accessToken: string,
	body: {
		display_name: string;
		birth_date: string;
		bio?: string;
	},
): Promise<Response> =>
	postJson("/v1/users", body, { Authorization: `Bearer ${accessToken}` });

/** users行を直接status=deletedへ更新する(docs/05 §2.5相当の退会の準備) */
const markDeleted = async (userId: string): Promise<void> => {
	await db
		.update(users)
		.set({ status: "deleted", updatedAt: new Date() })
		.where(eq(users.id, userId));
};

describe("POST /v1/users(docs/05 §3.2: 初回登録・18歳検証)", () => {
	it("未登録JWTで登録(20歳)すると201・sub付きJWTに付け替わり・refresh_tokenあり・D1にusers行が作られる", async () => {
		const subject = `register-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const birthDate = birthDateYearsAgo(20, 0);
		const res = await postUsers(preregToken, {
			display_name: "登録テスト太郎",
			birth_date: birthDate,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as RegisterResponse;
		// UserDTO(bio省略時は空文字・has_icon=false)
		expect(body.user.display_name).toBe("登録テスト太郎");
		expect(body.user.bio).toBe("");
		expect(body.user.has_icon).toBe(false);
		expect(body.user.id).toHaveLength(26);
		// 登録前JWTからsub付きJWTへの付け替え(docs/04 §4・05 §2.3)
		expect(body.access_token).not.toBe(preregToken);
		const claims = await verifyAccessToken(JWT_SECRET, body.access_token);
		expect(claims.sub).toBe(body.user.id);
		expect(claims.idpProvider).toBe("google");
		expect(claims.idpSubject).toBe(subject);
		expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
		expect(typeof body.refresh_token).toBe("string");
		// D1にusers行(active)とリフレッシュ族が1つ
		const [row] = await db
			.select()
			.from(users)
			.where(eq(users.authSubject, subject));
		expect(row?.status).toBe("active");
		expect(row?.id).toBe(body.user.id);
		expect(row?.displayName).toBe("登録テスト太郎");
		expect(row?.bio).toBe("");
		expect(row?.birthDate).toBe(birthDate);
		const families = await db
			.select()
			.from(refreshFamilies)
			.where(eq(refreshFamilies.userId, body.user.id));
		expect(families).toHaveLength(1);
		expect(families[0]?.status).toBe("active");
	});

	it("17歳は422 UNDER_AGE(users行は作られない)", async () => {
		const subject = `underage-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		// JSTの今日から17年前-1日 → 誕生日はまだ来ていない17歳
		const res = await postUsers(preregToken, {
			display_name: "17歳テスト",
			birth_date: birthDateYearsAgo(17, -1),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNDER_AGE");
		expect(body.error.details).toEqual({});
		const rows = await db
			.select()
			.from(users)
			.where(eq(users.authSubject, subject));
		expect(rows).toHaveLength(0);
	});

	it("削除済み行がある17歳でもUNDER_AGEを最優先で返す(再利用しない)", async () => {
		const subject = `underage-deleted-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const ok = await postUsers(preregToken, {
			display_name: "大人になってから登録",
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(ok.status).toBe(201);
		const okBody = (await ok.json()) as RegisterResponse;
		await markDeleted(okBody.user.id);
		// 退会後は未登録扱いなのでauth/tokenは再び登録前JWTを返す(docs/05 §2.2)
		const secondToken = await getPreRegistrationToken(subject);
		const res = await postUsers(secondToken, {
			display_name: "まだ17歳",
			birth_date: birthDateYearsAgo(17, -1),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNDER_AGE");
		// 行はdeletedのまま(再利用されない)
		const [row] = await db
			.select()
			.from(users)
			.where(eq(users.id, okBody.user.id));
		expect(row?.status).toBe("deleted");
	});

	it("birth_date書式不正(2000-1-1)は400 VALIDATION_FAILED", async () => {
		const preregToken = await getPreRegistrationToken(
			`format-${crypto.randomUUID()}`,
		);
		const res = await postUsers(preregToken, {
			display_name: "書式不正テスト",
			birth_date: "2000-1-1",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("同一(provider, subject)のactive行が既にある登録は400「既に登録済みです」", async () => {
		const subject = `conflict-${crypto.randomUUID()}`;
		// 登録前に同じsubjectの登録前JWTを2枚取っておく
		const token1 = await getPreRegistrationToken(subject);
		const token2 = await getPreRegistrationToken(subject);
		const first = await postUsers(token1, {
			display_name: "先に登録",
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(first.status).toBe(201);
		const res = await postUsers(token2, {
			display_name: "後に登録",
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.message).toBe("既に登録済みです");
	});

	it("登録済みJWT(sub付き)でのPOST /v1/usersは401(登録前トークンのみ・docs/05 §3.1)", async () => {
		const subject = `registered-jwt-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const ok = await postUsers(preregToken, {
			display_name: "登録済みJWTテスト",
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(ok.status).toBe(201);
		const okBody = (await ok.json()) as RegisterResponse;
		const res = await postUsers(okBody.access_token, {
			display_name: "二重登録",
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});

	it("display_name 41字は400 VALIDATION_FAILED(上限40字・docs/05 §2.2)", async () => {
		const preregToken = await getPreRegistrationToken(
			`toolong-${crypto.randomUUID()}`,
		);
		const res = await postUsers(preregToken, {
			display_name: "あ".repeat(41),
			birth_date: birthDateYearsAgo(20, 0),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});
});

describe("GET /v1/users/me(docs/05 §3.2)", () => {
	it("登録済みユーザーは200 UserDTO(has_icon=false)を返す", async () => {
		const subject = `me-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const registered = await postUsers(preregToken, {
			display_name: "meテスト",
			birth_date: birthDateYearsAgo(20, 0),
			bio: "はじめまして",
		});
		expect(registered.status).toBe(201);
		const registeredBody = (await registered.json()) as RegisterResponse;

		const res = await SELF.fetch("https://localhost/v1/users/me", {
			headers: { Authorization: `Bearer ${registeredBody.access_token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as UserDtoShape;
		expect(body).toEqual({
			id: registeredBody.user.id,
			display_name: "meテスト",
			bio: "はじめまして",
			has_icon: false,
		});
	});

	it("削除済みユーザー(status=deleted)のJWTは404 NOT_FOUND", async () => {
		const subject = `me-deleted-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const registered = await postUsers(preregToken, {
			display_name: "退会済みmeテスト",
			birth_date: birthDateYearsAgo(20, 0),
		});
		const registeredBody = (await registered.json()) as RegisterResponse;
		await markDeleted(registeredBody.user.id);

		const res = await SELF.fetch("https://localhost/v1/users/me", {
			headers: { Authorization: `Bearer ${registeredBody.access_token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("PATCH /v1/users/me(docs/05 §3.2)", () => {
	it("bioを更新すると200・bioが反映される(display_nameは不変)", async () => {
		const subject = `patch-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const registered = await postUsers(preregToken, {
			display_name: "patchテスト",
			birth_date: birthDateYearsAgo(20, 0),
		});
		const registeredBody = (await registered.json()) as RegisterResponse;

		const res = await requestJson(
			"PATCH",
			"/v1/users/me",
			{ bio: "よろしく" },
			{ Authorization: `Bearer ${registeredBody.access_token}` },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as UserDtoShape;
		expect(body.bio).toBe("よろしく");
		expect(body.display_name).toBe("patchテスト");

		// GET meでも更新後のbioが読める
		const got = await SELF.fetch("https://localhost/v1/users/me", {
			headers: { Authorization: `Bearer ${registeredBody.access_token}` },
		});
		const gotBody = (await got.json()) as UserDtoShape;
		expect(gotBody.bio).toBe("よろしく");
	});

	it("空オブジェクトは400 VALIDATION_FAILED(1フィールド以上必須)", async () => {
		const subject = `patch-empty-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const registered = await postUsers(preregToken, {
			display_name: "空更新テスト",
			birth_date: birthDateYearsAgo(20, 0),
		});
		const registeredBody = (await registered.json()) as RegisterResponse;

		const res = await requestJson(
			"PATCH",
			"/v1/users/me",
			{},
			{ Authorization: `Bearer ${registeredBody.access_token}` },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("削除済みユーザーのPATCHは404 NOT_FOUND(GET meと同じ扱い)", async () => {
		const subject = `patch-deleted-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const registered = await postUsers(preregToken, {
			display_name: "退会後patchテスト",
			birth_date: birthDateYearsAgo(20, 0),
		});
		const registeredBody = (await registered.json()) as RegisterResponse;
		await markDeleted(registeredBody.user.id);

		const res = await requestJson(
			"PATCH",
			"/v1/users/me",
			{ bio: "退会後の更新" },
			{ Authorization: `Bearer ${registeredBody.access_token}` },
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("削除済みユーザーの再登録(docs/05 §2.5: 削除は行を残す)", () => {
	it("auth/token→POST /v1/usersで同一行がactiveに復帰する(id不変・auth列不変・表示名等は更新)", async () => {
		const subject = `rejoin-${crypto.randomUUID()}`;
		const preregToken = await getPreRegistrationToken(subject);
		const first = await postUsers(preregToken, {
			display_name: "初回登録",
			birth_date: birthDateYearsAgo(25, 0),
		});
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as RegisterResponse;
		await markDeleted(firstBody.user.id);

		// 退会後は未登録扱い→登録前JWT→再登録(docs/05 §2.2・§3.2)
		const secondToken = await getPreRegistrationToken(subject);
		const second = await postUsers(secondToken, {
			display_name: "再登録後の表示名",
			birth_date: "1999-12-31",
			bio: "再登録しました",
		});
		expect(second.status).toBe(201);
		const secondBody = (await second.json()) as RegisterResponse;
		expect(secondBody.user.id).toBe(firstBody.user.id);

		// 同一行の復帰: id・auth列は不変、表示名/bio/birth_dateは更新(docs/05 §2.5)
		const [row] = await db
			.select()
			.from(users)
			.where(eq(users.id, firstBody.user.id));
		expect(row?.status).toBe("active");
		expect(row?.authProvider).toBe("google");
		expect(row?.authSubject).toBe(subject);
		expect(row?.displayName).toBe("再登録後の表示名");
		expect(row?.bio).toBe("再登録しました");
		expect(row?.birthDate).toBe("1999-12-31");

		// 新しいアクセストークンも同じsub
		const claims = await verifyAccessToken(JWT_SECRET, secondBody.access_token);
		expect(claims.sub).toBe(firstBody.user.id);
	});
});
