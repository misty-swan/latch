/**
 * Playwright設定(E2EはAPIレベルのみ・ブラウザ不要)。
 * webServerはローカルD1へのマイグレーション適用後にwrangler devを起動する
 * (.dev.varsは事前にscripts/prepare-dev-vars.mjsが生成・docs/04 §4のテスト鍵モード)。
 * --localはwrangler.jsoncのAIバインディングが引き起こすリモートプロキシセッション
 * (アカウント認証が必要)を無効化し、全バインディングをローカルエミュレータで完結
 * させるための指定(AGENTS.mdの環境方針・CIではトークン不要)。
 * 統合試験(vitest)とは別の起動経路であり、CIでは既存サーバーの再利用をしない
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	webServer: {
		command:
			"node scripts/prepare-dev-vars.mjs && wrangler d1 migrations apply DB --local && wrangler dev --local --port 8787",
		url: "http://localhost:8787/healthz",
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
	},
	use: {
		baseURL: "http://localhost:8787",
	},
});
