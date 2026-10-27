/**
 * IdPトークン検証の単体試験(docs/04 §4: テスト鍵モードと本番モード)。
 * バインディングに依存しない純粋な単体試験のためcloudflare:testは使わない(jwt.test.tsと同じ方針)。
 * テスト鍵は試験内でjoseのgenerateKeyPairで都度生成する
 * (tests/fixturesの鍵は統合試験・E2EがIDトークンを署名するためのもの)。
 */

import type { AuthProvider } from "@latch/shared";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
	IdpTokenError,
	TEST_IDP_AUDIENCE,
	TEST_IDP_ISSUER,
	verifyIdpToken,
} from "./idp";

/** テスト鍵モードのissuer/audienceの期待値(docs/04 §4の固定値・リテラルで突き合わせる) */
const EXPECTED_ISSUER = "urn:latch:test-idp";
const EXPECTED_AUDIENCE = "latch-test";

/** 試験内で生成した鍵に付けるkid */
const KID = "unit-test-key-1";

/** バインディングを参照しないため変数のみ与えるヘルパー(env.test.tsと同じ方針) */
const makeEnv = (overrides: Partial<Env> = {}): Env =>
	({ ...overrides }) as unknown as Env;

/** RSA鍵ペアを都度生成し、署名用privateKeyとkid付き公開JWKSを返す */
const makeKey = async (): Promise<{
	privateKey: CryptoKey;
	jwks: JSONWebKeySet;
}> => {
	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk = await exportJWK(publicKey);
	if (jwk.kty === undefined || jwk.n === undefined || jwk.e === undefined) {
		throw new Error("RSA公開鍵のJWK要素が欠落しています");
	}
	return {
		privateKey,
		jwks: {
			keys: [
				{
					kty: jwk.kty,
					n: jwk.n,
					e: jwk.e,
					kid: KID,
					alg: "RS256",
					use: "sig",
				},
			],
		},
	};
};

/** テスト鍵でIDトークンを署名する(iss/aud/sub/kid/expは引数で上書き可能) */
const signIdpToken = async (
	privateKey: CryptoKey,
	options: {
		issuer?: string;
		audience?: string;
		subject?: string;
		/** 保護ヘッダのkid(既定はKID・未知kidの試験では別の値を指定する) */
		kid?: string;
		/** expの現在時刻からのオフセット秒(既定600秒=有効) */
		expSecondsFromNow?: number;
		/** trueでexpを付与しない(docs/04 §4のexp必須検査の試験用) */
		noExp?: boolean;
	} = {},
): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	const jwt = new SignJWT({ sub: options.subject ?? "idp-subject-123" })
		.setProtectedHeader({ alg: "RS256", kid: options.kid ?? KID })
		.setIssuer(options.issuer ?? EXPECTED_ISSUER)
		.setAudience(options.audience ?? EXPECTED_AUDIENCE)
		.setIssuedAt(now);
	if (options.noExp !== true) {
		jwt.setExpirationTime(now + (options.expSecondsFromNow ?? 600));
	}
	return jwt.sign(privateKey);
};

/** sub無しのIDトークンを署名する(docs/04 §4のsub必須検査の試験用) */
const signWithoutSub = async (privateKey: CryptoKey): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(EXPECTED_ISSUER)
		.setAudience(EXPECTED_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(privateKey);
};

describe("テスト鍵モード(docs/04 §4: LATCH_TEST_IDP_JWKS設定時の検証)", () => {
	it("定数は固定値(TEST_IDP_ISSUER=urn:latch:test-idp・TEST_IDP_AUDIENCE=latch-test)", () => {
		expect(TEST_IDP_ISSUER).toBe(EXPECTED_ISSUER);
		expect(TEST_IDP_AUDIENCE).toBe(EXPECTED_AUDIENCE);
	});

	it("正しいテスト鍵+iss/aud/sub/exp → googleの{provider,subject,issuedAt}が返る", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey);
		const verified = await verifyIdpToken(
			makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
			"google",
			token,
		);
		expect(verified).toEqual({
			provider: "google",
			subject: "idp-subject-123",
			// iatは退会の再認証が新しさの確認に使う(docs/05 §3.3)
			issuedAt: expect.any(Number),
		});
	});

	it("appleも同様に検証できる", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey);
		const verified = await verifyIdpToken(
			makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
			"apple",
			token,
		);
		expect(verified).toEqual({
			provider: "apple",
			subject: "idp-subject-123",
			issuedAt: expect.any(Number),
		});
	});

	it("exp過ぎ → IdpTokenError", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey, { expSecondsFromNow: -3600 });
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("iss不一致 → IdpTokenError", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey, {
			issuer: "https://evil.example",
		});
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("aud不一致 → IdpTokenError", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey, { audience: "other-client" });
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("未知kid(別鍵で署名) → IdpTokenError", async () => {
		const { jwks } = await makeKey();
		const { privateKey } = await makeKey();
		// JWKSに無いkidで署名する(joseが一致鍵を見つけられず失敗する経路)
		const token = await signIdpToken(privateKey, { kid: "unknown-kid" });
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("kid一致でも別鍵の署名 → IdpTokenError", async () => {
		const { jwks } = await makeKey();
		const { privateKey } = await makeKey();
		// kidは一致するが署名鍵が別 material の場合も署名検証で失敗する
		const token = await signIdpToken(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("exp無し → IdpTokenError(exp必須・docs/04 §4)", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey, { noExp: true });
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("sub無し → IdpTokenError", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signWithoutSub(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("LATCH_TEST_IDP_JWKSが不正なJSON → IdpTokenError", async () => {
		const { privateKey } = await makeKey();
		const token = await signIdpToken(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: "{not-json" }),
				"google",
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});
});

describe("JWKSキャッシュ(モジュール内Map・キーは鍵JSON文字列・docs/04 §4)", () => {
	it("同一envでの2回目の検証も成功する(キャッシュ済み鍵で機能)", async () => {
		const { privateKey, jwks } = await makeKey();
		const env = makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) });
		for (let i = 0; i < 2; i++) {
			const token = await signIdpToken(privateKey, {
				subject: `idp-subject-${i}`,
			});
			const verified = await verifyIdpToken(env, "google", token);
			expect(verified.subject).toBe(`idp-subject-${i}`);
		}
	});

	it("キャッシュは鍵JSON文字列がキーのため、別JWKSへ差し替えると新しい鍵で検証される", async () => {
		const keyA = await makeKey();
		const keyB = await makeKey();
		const tokenA = await signIdpToken(keyA.privateKey);
		const tokenB = await signIdpToken(keyB.privateKey);
		await verifyIdpToken(
			makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(keyA.jwks) }),
			"google",
			tokenA,
		);
		const verifiedB = await verifyIdpToken(
			makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(keyB.jwks) }),
			"google",
			tokenB,
		);
		expect(verifiedB.subject).toBe("idp-subject-123");
	});
});

describe("本番モード(docs/04 §4: LATCH_TEST_IDP_JWKS未設定時の検証)", () => {
	it("googleでGOOGLE_CLIENT_ID未設定 → IdpTokenError(設定欠落は認証失敗として扱う)", async () => {
		const { privateKey } = await makeKey();
		const token = await signIdpToken(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(makeEnv(), "google", token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});

	it("appleでAPPLE_CLIENT_ID未設定 → IdpTokenError(設定欠落は認証失敗として扱う)", async () => {
		const { privateKey } = await makeKey();
		const token = await signIdpToken(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(makeEnv(), "apple", token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});
});

describe("provider引数の実行時検査(docs/05 §2.2: google/appleのみ)", () => {
	it("未知のprovider → IdpTokenError", async () => {
		const { privateKey, jwks } = await makeKey();
		const token = await signIdpToken(privateKey);
		let caught: unknown;
		try {
			await verifyIdpToken(
				makeEnv({ LATCH_TEST_IDP_JWKS: JSON.stringify(jwks) }),
				"microsoft" as AuthProvider,
				token,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IdpTokenError);
	});
});

describe("本番モードのiss/aud(docs/04 §4: 公開鍵の取得はfetchを差し替え・本物のIdPには接続しない)", () => {
	const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
	const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
	let key: Awaited<ReturnType<typeof makeKey>>;
	const env = makeEnv({
		GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
		APPLE_CLIENT_ID: "jp.example.latch.web",
	});

	beforeAll(async () => {
		key = await makeKey();
	});

	/** 公開鍵の取得だけを試験の鍵で応える(joseはURLごとにリゾルバを1回作るため鍵は全試験で共有する) */
	const stubJwksFetch = (): void => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === GOOGLE_JWKS || url === APPLE_JWKS) {
				return new Response(JSON.stringify(key.jwks), {
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`想定外の取得: ${url}`);
		});
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("googleはiss=https://accounts.google.comを受け付ける", async () => {
		stubJwksFetch();
		const token = await signIdpToken(key.privateKey, {
			issuer: "https://accounts.google.com",
			audience: "google-client.apps.googleusercontent.com",
		});
		const verified = await verifyIdpToken(env, "google", token);
		expect(verified).toMatchObject({
			provider: "google",
			subject: "idp-subject-123",
		});
	});

	it("googleはiss=accounts.google.com(スキーム無し)も受け付ける", async () => {
		stubJwksFetch();
		const token = await signIdpToken(key.privateKey, {
			issuer: "accounts.google.com",
			audience: "google-client.apps.googleusercontent.com",
		});
		const verified = await verifyIdpToken(env, "google", token);
		expect(verified.provider).toBe("google");
	});

	it("googleで別のissやaud → IdpTokenError", async () => {
		stubJwksFetch();
		const wrongIss = await signIdpToken(key.privateKey, {
			issuer: "https://evil.example.com",
			audience: "google-client.apps.googleusercontent.com",
		});
		await expect(
			verifyIdpToken(env, "google", wrongIss),
		).rejects.toBeInstanceOf(IdpTokenError);
		const wrongAud = await signIdpToken(key.privateKey, {
			issuer: "https://accounts.google.com",
			audience: "other-client",
		});
		await expect(
			verifyIdpToken(env, "google", wrongAud),
		).rejects.toBeInstanceOf(IdpTokenError);
	});

	it("appleはiss=https://appleid.apple.com・aud=APPLE_CLIENT_ID(Services ID)を受け付け、googleのissは拒む", async () => {
		stubJwksFetch();
		const token = await signIdpToken(key.privateKey, {
			issuer: "https://appleid.apple.com",
			audience: "jp.example.latch.web",
		});
		const verified = await verifyIdpToken(env, "apple", token);
		expect(verified.provider).toBe("apple");
		const googleIss = await signIdpToken(key.privateKey, {
			issuer: "https://accounts.google.com",
			audience: "jp.example.latch.web",
		});
		await expect(
			verifyIdpToken(env, "apple", googleIss),
		).rejects.toBeInstanceOf(IdpTokenError);
	});
});
