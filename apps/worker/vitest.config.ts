/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
	// wrangler設定のmigrations_dirにあるマイグレーションSQLを読み込む。
	// 適用はsetup file(tests/apply-d1-migrations.ts)がTEST_MIGRATIONSバインディング経由で行う
	const migrations = await readD1Migrations(
		path.join(import.meta.dirname, "migrations"),
	);
	// テスト専用IdPの公開JWKS(docs/04 §4)。統合試験がIdPトークンをこの鍵で検証する。
	// 文字列値はそのままプレーン変数としてバインドされる
	const testIdpJwks = fs.readFileSync(
		path.join(import.meta.dirname, "tests/fixtures/test-idp-jwks.json"),
		"utf8",
	);
	// テスト専用IdPの秘密JWK(devサインインPOST /v1/dev/idp-tokenが署名に使う・
	// F2'計画Task 2)。統合試験がdev/idp-token→auth/tokenの連結を検証できるようにする
	const testIdpPrivateJwk = fs.readFileSync(
		path.join(import.meta.dirname, "tests/fixtures/test-idp-private.jwk"),
		"utf8",
	);

	// テスト専用VAPID鍵(F7b設計 §5.5)。公開鍵とJWKをバインディングへ渡す
	const testVapid = JSON.parse(
		fs.readFileSync(
			path.join(import.meta.dirname, "tests/fixtures/test-vapid.json"),
			"utf8",
		),
	) as { publicKey: string; privateJwk: unknown };

	return {
		plugins: [
			cloudflareTest({
				// ローカルのminiflareエミュレータで完結させる(アカウント不要・CLAUDE.md環境方針)
				remoteBindings: false,
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					compatibilityFlags: ["nodejs_compat"],
					// マイグレーション適用用のテスト専用バインディング(非文字列はJSONバインディングになる)
					bindings: {
						TEST_MIGRATIONS: migrations,
						// JWT署名鍵(docs/10 §1: テスト用の値)
						JWT_SECRET: "unit-test-jwt-secret-0123456789ab",
						LATCH_TEST_IDP_JWKS: testIdpJwks,
						LATCH_TEST_IDP_PRIVATE_JWKS: testIdpPrivateJwk,
						VAPID_PUBLIC_KEY: testVapid.publicKey,
						VAPID_PRIVATE_KEY: JSON.stringify(testVapid.privateJwk),
						VAPID_SUBJECT: "mailto:dev@example.com",
						// キューの自動消費を止める印(src/env.ts・index.tsのqueueハンドラ参照)。
						// テストがsendしたメッセージの消費による副作用を防ぎ、消費の試験は
						// createMessageBatchでhandleQueueBatchを直接呼んで行う
						TEST_QUEUES_DISABLED: "1",
						// 応答の後の第1段・第2段(#30・設計 §3.5)を止める。既存の試験はキューの消費を
						// handleQueueBatchで直接呼ぶ作法のため。応答の後の処理の試験だけenvを差し替えてonにする
						LATCH_INLINE_PIPELINE: "off",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./tests/apply-d1-migrations.ts"],
			// e2e/・staging-e2e/はPlaywrightが担う(test:e2e・test:staging-e2e)。既定のincludeは
			// **/*.spec.tsまで見るためcloudflareプールから外す
			exclude: [...configDefaults.exclude, "e2e/**", "staging-e2e/**"],
		},
	};
});
