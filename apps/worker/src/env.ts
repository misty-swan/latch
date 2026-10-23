/**
 * Workerの環境変数・バインディングの型と、prod起動ガード(docs/04 §4・docs/10 §2)。
 * assertEnvSafetyはfetchの先頭でisolateごとに1回だけ呼ぶ(Workersに起動フックはないため)。
 */
import type { MatchQueueMessage } from "@latch/shared";
import type { VapidKeys } from "./push/vapid";

/**
 * 開発/テスト専用のJWT署名鍵フォールバック(wrangler dev・単体/統合テスト用)。
 * prodでは使用されない: assertEnvSafetyが32字以上のJWT_SECRET設定を強制する(docs/10 §2)
 */
export const DEV_FALLBACK_JWT_SECRET =
	"latch-dev-fallback-jwt-secret-0123456789abcdef";

/**
 * テスト専用VAPID公開鍵(tests/fixtures/test-vapid.jsonのpublicKeyと同値・env.test.tsで一致を確認)。
 * prodでこの鍵が設定されていたら起動を拒否する(F7b設計 §5.5・docs/10 §2のテスト鍵ガード)
 */
export const TEST_VAPID_PUBLIC_KEY =
	"BLJmICs7vvlwpXh8sEtokHetiJR7lGLHYnKZp2_DCOcWDiQdnR_-jWxp9OwI2vs8zWVLnF8A9QitEquRXZ_FYro";

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
	/** チャットルームのDurable Object(成立LATCHごとに1DO・F6a設計 §1)。Workerのルートからのみ到達する */
	CHAT_DO: DurableObjectNamespace;
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
	/** Web Pushの送り手(既定stub・push/sender.ts)。prodはreal必須(F7b設計 §5.5) */
	LATCH_PUSH_MODE?: string;
	/** VAPID公開鍵(base64url・非圧縮P-256点)。stubでも公開鍵APIが返す */
	VAPID_PUBLIC_KEY?: string;
	/** VAPID秘密鍵(JWKのJSON文字列) */
	VAPID_PRIVATE_KEY?: string;
	/** VAPIDのsub(mailto:) */
	VAPID_SUBJECT?: string;
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

/** VAPIDのsubが仮の送信者か(mailto:で、@の後が.invalidで終わるかexample.com/org/net。大文字小文字を区別しない) */
const isPlaceholderVapidSubject = (subject: string): boolean => {
	const trimmed = subject.trim();
	if (!trimmed.toLowerCase().startsWith("mailto:")) return false;
	// ?以降(mailtoのヘッダ)と末尾のドット(FQDN表記)を除いてドメインを取り出す
	const address = trimmed.split("?")[0] ?? "";
	const domain = address
		.slice(address.lastIndexOf("@") + 1)
		.toLowerCase()
		.replace(/\.+$/, "");
	return (
		domain.endsWith(".invalid") ||
		["example.com", "example.org", "example.net"].includes(domain)
	);
};

/** 環境変数からVAPID鍵一式を作る(未設定は例外・F7b設計 §5.5) */
export const vapidKeysOf = (env: Env): VapidKeys => {
	if (
		env.VAPID_PUBLIC_KEY === undefined ||
		env.VAPID_PRIVATE_KEY === undefined ||
		env.VAPID_SUBJECT === undefined
	) {
		throw new Error(
			"ENV_MISSING_VAPID: VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECTが必要(F7b設計 §5.5)",
		);
	}
	return {
		publicKey: env.VAPID_PUBLIC_KEY,
		privateJwk: JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey,
		subject: env.VAPID_SUBJECT,
	};
};

/**
 * prod起動ガード(docs/04 §4・docs/10 §2)。fetchの先頭で呼ぶことを想定する。
 * - prodでテスト鍵(LATCH_TEST_IDP_JWKS・LATCH_TEST_IDP_PRIVATE_JWKS)が残存 →
 *   例外(テスト鍵でprodを起動させない。秘密鍵はdevサインイン用のF2'計画Task 2)
 * - prodでJWT_SECRETが未設定・32字未満 → 例外
 * - prodでLATCH_PUSH_MODEがreal以外 → 例外(ENV_UNSAFE_PUSH)・VAPID_*の欠落 → 例外
 *   (ENV_MISSING_VAPID)・VAPID公開鍵がテスト鍵 → 例外(ENV_UNSAFE_TEST_KEY)(F7b設計 §5.5)
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
	if (env.LATCH_PUSH_MODE !== "real") {
		throw new Error(
			"ENV_UNSAFE_PUSH: prod環境ではLATCH_PUSH_MODE=realが必須(F7b設計 §5.5)",
		);
	}
	if (
		env.VAPID_PUBLIC_KEY === undefined ||
		env.VAPID_PRIVATE_KEY === undefined ||
		env.VAPID_SUBJECT === undefined
	) {
		throw new Error(
			"ENV_MISSING_VAPID: prod環境ではVAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECTが必須(F7b設計 §5.5)",
		);
	}
	if (env.VAPID_PUBLIC_KEY === TEST_VAPID_PUBLIC_KEY) {
		throw new Error(
			"ENV_UNSAFE_TEST_KEY: prod環境でテスト用VAPID鍵が設定されている(docs/10 §2)",
		);
	}
	if (isPlaceholderVapidSubject(env.VAPID_SUBJECT)) {
		throw new Error(
			"ENV_PLACEHOLDER_VAPID_SUBJECT: prod環境でVAPID_SUBJECTが仮の送信者(.invalid・example.com/org/net)のまま。実在する連絡先のmailto:を設定する(docs/10 §2)",
		);
	}
};
