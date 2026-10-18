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

	return {
		plugins: [
			cloudflareTest({
				// ローカルのminiflareエミュレータで完結させる(アカウント不要・AGENTS.md環境方針)
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
					},
				},
			}),
		],
		test: {
			setupFiles: ["./tests/apply-d1-migrations.ts"],
			// e2e/はPlaywrightが担う(test:e2e)。既定のincludeは**/*.spec.tsまで
			// 見るためcloudflareプールから外す
			exclude: [...configDefaults.exclude, "e2e/**"],
		},
	};
});
