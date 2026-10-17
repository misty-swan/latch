/// <reference types="node" />
import path from "node:path";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	// wrangler設定のmigrations_dirにあるマイグレーションSQLを読み込む。
	// 適用はsetup file(tests/apply-d1-migrations.ts)がTEST_MIGRATIONSバインディング経由で行う
	const migrations = await readD1Migrations(
		path.join(import.meta.dirname, "migrations"),
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
					bindings: { TEST_MIGRATIONS: migrations },
				},
			}),
		],
		test: {
			setupFiles: ["./tests/apply-d1-migrations.ts"],
		},
	};
});
