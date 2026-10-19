/**
 * dev専用サインインルート(F2'計画Task 2: POST /v1/dev/idp-token)。
 * - ブラウザE2E・ローカル開発のサインイン入口。コミット済みテスト鍵(tests/fixturesの
 *   秘密JWK・docs/04 §4)でRS256署名したIdPトークンを返す(iss/audはテスト専用の
 *   固定値・exp=now+600秒)。受け取ったトークンは通常どおりPOST /v1/auth/tokenで
 *   検証されるため、認証フローに特別経路を作らない
 * - 存在を隠す: LATCH_ENV==="production"、またはテスト鍵モードの変数
 *   (LATCH_TEST_IDP_PRIVATE_JWKS・LATCH_TEST_IDP_JWKS)が未設定のときは一律
 *   404 NOT_FOUND(理由は区別できない・docs/05 §3.1)。prodでは加えて
 *   assertEnvSafetyが秘密鍵の設定自体を拒否する二重防御(docs/10 §2)
 * - 認証は不要(このエンドポイント自体がサインインの入口のため)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockをimportして使う
 */

import { devIdpTokenRequestSchema } from "@latch/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { importJWK, SignJWT } from "jose";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../auth/idp";
import type { AppEnv } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { errorJson } from "../http/errors";
import { createLogger } from "../logging/logger";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。subjectは決して出力しない */
const logger = createLogger();

/** dev専用サインインのサブアプリ。index.tsが /v1/dev にマウントする */
export const devRoutes = new Hono<AppEnv>();

/** 発行するIdPトークンの寿命(秒・テストヘルパーsignIdpTokenと同じ600秒) */
const IDP_TOKEN_TTL_SECONDS = 600;

/** 秘密JWKの署名鍵への変換結果の簡易キャッシュ(鍵JSON文字列ごと・isolateで1回のimport) */
const signingKeyCache = new Map<string, Promise<CryptoKey>>();

/** 秘密JWK文字列→RS256署名鍵(importは非同期のためPromiseをキャッシュする) */
const signingKeyOf = (privateJwkJson: string): Promise<CryptoKey> => {
	let key = signingKeyCache.get(privateJwkJson);
	if (key === undefined) {
		key = importJWK(
			JSON.parse(privateJwkJson) as Record<string, unknown>,
			"RS256",
		) as Promise<CryptoKey>;
		signingKeyCache.set(privateJwkJson, key);
	}
	return key;
};

/** 存在を隠すための一律404(prod・テスト鍵未設定を区別しない) */
const notFound = (c: Context<AppEnv>): Response => {
	const r = errorJson("NOT_FOUND", "リソースが見つかりません");
	return c.json(r.body, r.status);
};

/** JSONボディを読む。空ボディは{}、JSON不正はundefined(400扱い) */
const readJsonBody = async (c: Context<AppEnv>): Promise<unknown> => {
	try {
		const text = await c.req.text();
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return undefined;
	}
};

devRoutes.post("/idp-token", async (c) => {
	// 存在を隠す検査をボディ検証より先に行う(存在しないルートと同じ振る舞いに見せる)。
	// 公開JWKSの未設定も404に含める(署名できても検証できない構成では入口として無意味)
	if (
		c.env.LATCH_ENV === "production" ||
		c.env.LATCH_TEST_IDP_PRIVATE_JWKS === undefined ||
		c.env.LATCH_TEST_IDP_JWKS === undefined
	) {
		logger.warn("dev.signin.rejected", { error_code: "NOT_FOUND" });
		return notFound(c);
	}
	const parsed = devIdpTokenRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = errorJson("VALIDATION_FAILED", "リクエストボディが不正です");
		return c.json(r.body, r.status);
	}
	const privateJwkText = c.env.LATCH_TEST_IDP_PRIVATE_JWKS;
	const { kid } = JSON.parse(privateJwkText) as { kid: string };
	const nowSeconds = Math.floor(systemClock.now().getTime() / 1000);
	const idpToken = await new SignJWT({ sub: parsed.data.subject })
		.setProtectedHeader({ alg: "RS256", kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + IDP_TOKEN_TTL_SECONDS)
		.sign(await signingKeyOf(privateJwkText));
	// subject等は出さない(docs/08 §6の許可フィールドにも無い)
	logger.info("dev.signin.issued");
	return c.json({ idp_token: idpToken });
});
