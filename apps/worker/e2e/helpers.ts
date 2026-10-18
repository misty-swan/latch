/**
 * E2E用ヘルパー(docs/04 §4: テスト鍵モードのIdPトークン署名)。
 * PlaywrightのspecはNode(workerd外)で実行されるため、コミット済みテスト鍵の
 * 秘密JWKを実FSから読んでjoseで署名できる(統合試験の?raw読み込みとは逆の前提)。
 * Worker側は .dev.vars の LATCH_TEST_IDP_JWKS(prepare-dev-vars.mjsが生成)で
 * 同じ鍵の公開JWKSを検証する。テスト専用の値であり、prodではassertEnvSafetyが
 * 同じ変数の設定自体を拒否する(docs/10 §2)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPair, importJWK, SignJWT } from "jose";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";

/** コミット済みテスト鍵の秘密JWK(Task 5の生成物・E2E専用に署名へ使う) */
const privateJwk = JSON.parse(
	readFileSync(
		path.join(import.meta.dirname, "../tests/fixtures/test-idp-private.jwk"),
		"utf8",
	),
) as { kid: string } & Record<string, unknown>;

/** 署名鍵の遅延生成(spec実行ごとに1回) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/**
 * テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud)。
 * expは現在時刻+600秒=有効
 */
export const signIdpToken = async (sub: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(await signingKey());
};

/**
 * でっち上げトークン(鍵不一致): iss/audは正しいが別鍵で署名したIdPトークン。
 * 署名検証が実際に鍵を確認していることのE2E確認用(docs/04 §4)
 */
export const signForeignIdpToken = async (sub: string): Promise<string> => {
	const { privateKey } = await generateKeyPair("RS256", {
		modulusLength: 2048,
	});
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub })
		.setProtectedHeader({ alg: "RS256", kid: "forged-key" })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(privateKey);
};
