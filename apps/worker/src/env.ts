/**
 * Workerの環境変数・バインディングの型と、prod起動ガード(docs/04 §4・docs/10 §2)。
 * assertEnvSafetyはfetchの先頭でisolateごとに1回だけ呼ぶ(Workersに起動フックはないため)。
 */

/**
 * 開発/テスト専用のJWT署名鍵フォールバック(wrangler dev・単体/統合テスト用)。
 * prodでは使用されない: assertEnvSafetyが32字以上のJWT_SECRET設定を強制する(docs/10 §2)
 */
export const DEV_FALLBACK_JWT_SECRET =
	"latch-dev-fallback-jwt-secret-0123456789abcdef";

/**
 * WorkerのEnv(バインディング=docs/04 §3.1・実行環境の値=docs/10 §1)。
 * JWT_SECRET等のsecretはデプロイ時に投入されるため省略可能としている
 */
export interface Env {
	DB: D1Database;
	REVOCATION_KV: KVNamespace;
	ICONS: R2Bucket;
	/** Layer 2 Candidate Retrieval用ベクトルインデックス(docs/05 §2.3・docs/07 §1)。localでは使わずインメモリ実装へ倒す(vectorstore/index.ts) */
	VECTORS: VectorizeIndex;
	LATCH_LLM_MODE: string;
	LATCH_ENV: string;
	JWT_SECRET?: string;
	LATCH_TEST_IDP_JWKS?: string;
	/**
	 * dev専用サインイン(POST /v1/dev/idp-token)のRS256署名鍵
	 * (fixturesの秘密JWKのJSON文字列・F2'計画Task 2)。prepare-dev-vars.mjsが
	 * .dev.varsへ生成し、ローカル/CI/E2Eのみに存在する。prodではassertEnvSafetyが
	 * 設定自体を拒否する(docs/10 §2)
	 */
	LATCH_TEST_IDP_PRIVATE_JWKS?: string;
	GOOGLE_CLIENT_ID?: string;
	APPLE_CLIENT_ID?: string;
}

/**
 * JWT署名鍵を解決する(docs/04 §4の認証・セッション)。
 * prodは設定済みのJWT_SECRETが必須(未設定なら例外)。それ以外は未設定時に開発/テスト専用鍵へ倒す
 */
export const jwtSecret = (env: Env): string => {
	if (env.LATCH_ENV === "production") {
		if (env.JWT_SECRET === undefined) {
			throw new Error(
				"JWT_SECRET_MISSING: prod環境ではJWT_SECRETが必須(docs/04 §4)",
			);
		}
		return env.JWT_SECRET;
	}
	return env.JWT_SECRET ?? DEV_FALLBACK_JWT_SECRET;
};

/**
 * prod起動ガード(docs/04 §4・docs/10 §2)。fetchの先頭で呼ぶことを想定する。
 * - prodでテスト鍵(LATCH_TEST_IDP_JWKS・LATCH_TEST_IDP_PRIVATE_JWKS)が残存 →
 *   例外(テスト鍵でprodを起動させない。秘密鍵はdevサインイン用のF2'計画Task 2)
 * - prodでJWT_SECRETが未設定・32字未満 → 例外
 * prod以外(LATCH_ENVがproduction以外)は何もしない
 */
export const assertEnvSafety = (env: Env): void => {
	if (env.LATCH_ENV !== "production") {
		return;
	}
	if (env.LATCH_TEST_IDP_JWKS !== undefined) {
		throw new Error(
			"ENV_UNSAFE_TEST_KEY: prod環境でテスト鍵(LATCH_TEST_IDP_JWKS)が設定されている(docs/10 §2)",
		);
	}
	if (env.LATCH_TEST_IDP_PRIVATE_JWKS !== undefined) {
		throw new Error(
			"ENV_UNSAFE_TEST_KEY: prod環境でテスト鍵(LATCH_TEST_IDP_PRIVATE_JWKS)が設定されている(docs/10 §2)",
		);
	}
	if (env.JWT_SECRET === undefined || env.JWT_SECRET.length < 32) {
		throw new Error(
			"ENV_UNSAFE_JWT_SECRET: prod環境では32字以上のJWT_SECRETが必須(docs/04 §4)",
		);
	}
};
