/**
 * IdP(Google/Apple)が発行するIDトークンの検証(docs/04 §4: 外部IdPのIDトークン検証)。
 * - テスト鍵モード: env.LATCH_TEST_IDP_JWKSに公開JWKSを直接注入しcreateLocalJWKSetで検証
 *   (iss/audはテスト専用の固定値)。prodではassertEnvSafetyがLATCH_TEST_IDP_JWKSの
 *   設定自体を拒否する(docs/10 §2)ため、コミット済みテスト鍵が本番で使われることはない
 * - 本番モード(未設定時): 各IdPの公開JWKSをcreateRemoteJWKSetで参照(iss/audは各IdPの公式値)
 * いずれの失敗もIdpTokenError(呼び出し元は401 UNAUTHORIZEDへ対応付ける・docs/05 §3.1)
 */

import type { AuthProvider } from "@latch/shared";
import { AUTH_PROVIDERS } from "@latch/shared";
import {
	createLocalJWKSet,
	createRemoteJWKSet,
	type FlattenedJWSInput,
	type GetKeyFunction,
	type JSONWebKeySet,
	type JWTHeaderParameters,
	type JWTPayload,
	jwtVerify,
} from "jose";
import type { Env } from "../env";

/** テスト鍵モードのissuer(docs/04 §4: テスト専用の固定値) */
export const TEST_IDP_ISSUER = "urn:latch:test-idp";

/** テスト鍵モードのaudience(docs/04 §4: テスト専用の固定値) */
export const TEST_IDP_AUDIENCE = "latch-test";

/** googleの本番JWKSとissuer(docs/04 §4)。Googleはissに`https://accounts.google.com`と
 * `accounts.google.com`のどちらも使うため両方を受け付ける */
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = [
	"https://accounts.google.com",
	"accounts.google.com",
];

/** appleの本番JWKSとissuer(docs/04 §4) */
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_ISSUER = "https://appleid.apple.com";

/** IdPトークン検証の失敗(署名不一致・iss/aud/exp不一致・設定欠落等すべてを含む) */
export class IdpTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdpTokenError";
	}
}

/** 検証済みIdPトークンの結果 */
export interface VerifiedIdp {
	/** 認証プロバイダ(docs/05 §2.2: users.auth_provider) */
	provider: AuthProvider;
	/** IdP側のサブジェクト */
	subject: string;
	/** 発行時刻(iat・秒)。無ければundefined(退会の再認証が新しさの確認に使う・docs/05 §3.3) */
	issuedAt?: number;
}

/** ローカルJWKS(テスト鍵)の簡易キャッシュ。テストの分離のためキーは鍵JSON文字列(docs/04 §4) */
const localJwksCache = new Map<string, ReturnType<typeof createLocalJWKSet>>();

/** リモートJWKSの簡易キャッシュ。HTTP取得自体はjose内部でキャッシュするため、
 * リゾルバの構築はURLごとに1回でよい */
const remoteJwksCache = new Map<
	string,
	ReturnType<typeof createRemoteJWKSet>
>();

/** プロバイダごとの本番モード設定(docs/04 §4) */
const prodConfig = (
	env: Env,
	provider: AuthProvider,
): { jwksUrl: string; issuer: string[]; audience: string | undefined } => {
	if (provider === "google") {
		return {
			jwksUrl: GOOGLE_JWKS_URL,
			issuer: GOOGLE_ISSUERS,
			audience: env.GOOGLE_CLIENT_ID,
		};
	}
	return {
		jwksUrl: APPLE_JWKS_URL,
		issuer: [APPLE_ISSUER],
		audience: env.APPLE_CLIENT_ID,
	};
};

/** jwtVerifyの共通処理(署名・iss/aud・RS256をjoseが検証。sub・expは必須・docs/04 §4) */
const verifyWith = async (
	getKey: GetKeyFunction<JWTHeaderParameters, FlattenedJWSInput>,
	expected: { issuer: string | string[]; audience: string },
	provider: AuthProvider,
	token: string,
): Promise<VerifiedIdp> => {
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, getKey, {
			issuer: expected.issuer,
			audience: expected.audience,
			algorithms: ["RS256"],
		}));
	} catch (error) {
		// joseの例外(署名不一致・期限切れ・iss/aud不一致・未知kid等)はすべて認証失敗に畳む。
		// 理由はjoseのエラーコード(例: ERR_JWT_EXPIRED)を優先し、内部詳細の露出を抑える
		const reason =
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: error instanceof Error
					? error.message
					: String(error);
		throw new IdpTokenError(
			`IDP_TOKEN_INVALID: IdPトークンが不正(${reason}・docs/04 §4)`,
		);
	}
	if (typeof payload.exp !== "number") {
		throw new IdpTokenError(
			"IDP_TOKEN_INVALID: expが欠落している(docs/04 §4: exp必須)",
		);
	}
	if (typeof payload.sub !== "string") {
		throw new IdpTokenError("IDP_TOKEN_INVALID: subが欠落している(docs/04 §4)");
	}
	return {
		provider,
		subject: payload.sub,
		...(typeof payload.iat === "number" ? { issuedAt: payload.iat } : {}),
	};
};

/** テスト鍵モードの検証(env.LATCH_TEST_IDP_JWKS設定時・docs/04 §4) */
const verifyWithTestKey = (
	env: Env,
	provider: AuthProvider,
	token: string,
): Promise<VerifiedIdp> => {
	const jwksJson = env.LATCH_TEST_IDP_JWKS;
	if (jwksJson === undefined) {
		throw new IdpTokenError(
			"IDP_TOKEN_INVALID: LATCH_TEST_IDP_JWKSが未設定(docs/04 §4)",
		);
	}
	let getKey = localJwksCache.get(jwksJson);
	if (getKey === undefined) {
		let jwks: JSONWebKeySet;
		try {
			jwks = JSON.parse(jwksJson) as JSONWebKeySet;
		} catch {
			throw new IdpTokenError(
				"IDP_TOKEN_INVALID: LATCH_TEST_IDP_JWKSが不正なJSON(docs/04 §4)",
			);
		}
		getKey = createLocalJWKSet(jwks);
		localJwksCache.set(jwksJson, getKey);
	}
	return verifyWith(
		getKey,
		{ issuer: TEST_IDP_ISSUER, audience: TEST_IDP_AUDIENCE },
		provider,
		token,
	);
};

/**
 * IdPのIDトークンを検証する(docs/04 §4)。
 * env.LATCH_TEST_IDP_JWKS設定時はテスト鍵モード(iss/aud固定・exp必須)、
 * 未設定時は本番モード(google/appleの公式JWKS・iss/aud)。
 * client id未設定は設定欠落として認証失敗(IdpTokenError)にする(docs/04 §4)
 */
export const verifyIdpToken = async (
	env: Env,
	provider: AuthProvider,
	token: string,
): Promise<VerifiedIdp> => {
	// providerは実行時にも検査する(型だけを信用しない・docs/05 §2.2: google/appleのみ)
	if (!AUTH_PROVIDERS.includes(provider)) {
		throw new IdpTokenError(
			"IDP_TOKEN_INVALID: 未対応のprovider(docs/05 §2.2: google/appleのみ)",
		);
	}
	if (env.LATCH_TEST_IDP_JWKS !== undefined) {
		return verifyWithTestKey(env, provider, token);
	}
	// 本番モード(テスト鍵未設定): client id未設定は認証失敗として扱う(docs/04 §4)
	const config = prodConfig(env, provider);
	if (config.audience === undefined) {
		throw new IdpTokenError(
			`IDP_TOKEN_CONFIG_MISSING: ${provider}のclient idが未設定(設定欠落は認証失敗として扱う・docs/04 §4)`,
		);
	}
	let getKey = remoteJwksCache.get(config.jwksUrl);
	if (getKey === undefined) {
		getKey = createRemoteJWKSet(new URL(config.jwksUrl));
		remoteJwksCache.set(config.jwksUrl, getKey);
	}
	return verifyWith(
		getKey,
		{ issuer: config.issuer, audience: config.audience },
		provider,
		token,
	);
};
