/**
 * Workerの環境変数・バインディングの型と、prod起動ガード(docs/04 §4・docs/10 §2)。
 * assertEnvSafetyはfetchの先頭でisolateごとに1回だけ呼ぶ(Workersに起動フックはないため)。
 */
import type { MatchQueueMessage } from "@latch/shared";

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
	/** circuit breaker・予算アラートの送信済み印(docs/06 §5・§6) */
	PIPELINE_KV: KVNamespace;
	ICONS: R2Bucket;
	/** Layer 2 Candidate Retrieval用ベクトルインデックス(docs/05 §2.3・docs/07 §1)。localでは使わずインメモリ実装へ倒す(vectorstore/index.ts) */
	VECTORS: VectorizeIndex;
	/** Workers AI(Embedding=bge-m3・docs/07 §1)。LATCH_EMBEDDING_MODE=real時のみ使用する(llm/embedding.ts) */
	AI: Ai;
	/** マッチングパイプラインのイベントキュー(docs/04 §2・§4)。メッセージ本体=sharedのMatchQueueMessage */
	MATCH_QUEUE: Queue<MatchQueueMessage>;
	/** パイプラインのメトリクス送信先(docs/04 §4)。dataset=latch_metrics */
	PIPELINE_AX: AnalyticsEngineDataset;
	LATCH_LLM_MODE: string;
	/** Embeddingの動作モード(既定stub・llm/embedding.ts)。Parser/JevのLATCH_LLM_MODEとは独立に切り替える(07 §2) */
	LATCH_EMBEDDING_MODE?: string;
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
	/**
	 * 単体・統合試験(vitest)専用の印。設定されている間はQueues consumerの
	 * 自動消費を行わない(index.tsのqueueハンドラで判定する)。
	 * vitest-pool-workersのminiflareはテスト内でsendされたメッセージを自動消費し、
	 * 消費の副作用が既存試験の前提を壊すため、vitest.config.tsのminiflare.bindings
	 * のみに設定する(TEST_MIGRATIONSと同じ前例)。消費の試験は
	 * createMessageBatchでhandleQueueBatchを直接呼んで行う(pipeline-consumer.test.ts)。
	 * wrangler.jsonc・.dev.varsには存在しない。prodで設定が漏れた場合は
	 * パイプラインの消費が黙って止まるため、assertEnvSafetyが起動を拒否する
	 * (docs/10 §2のテスト鍵ガードと同じ二重防御)
	 */
	TEST_QUEUES_DISABLED?: string;
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
	// キュー消費停止印のprod混入はパイプラインの消費を黙って止めるため起動ごと拒否する
	if (env.TEST_QUEUES_DISABLED !== undefined) {
		throw new Error(
			"ENV_UNSAFE_TEST_QUEUE_GUARD: prod環境でTEST_QUEUES_DISABLEDが設定されている(docs/10 §2)",
		);
	}
	if (env.JWT_SECRET === undefined || env.JWT_SECRET.length < 32) {
		throw new Error(
			"ENV_UNSAFE_JWT_SECRET: prod環境では32字以上のJWT_SECRETが必須(docs/04 §4)",
		);
	}
};
