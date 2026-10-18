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

// 既定8787。ローカルで他プロジェクトが8787を占有する場合は
// `LATCH_E2E_PORT=<空きポート>` を指定(占有されたサーバーを誤再利用しない)。
const e2ePort = process.env.LATCH_E2E_PORT ?? "8787";

export default defineConfig({
	testDir: "./e2e",
	webServer: {
		command: `node scripts/prepare-dev-vars.mjs && wrangler d1 migrations apply DB --local && wrangler dev --local --port ${e2ePort}`,
		url: `http://localhost:${e2ePort}/healthz`,
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
	},
	use: {
		baseURL: `http://localhost:${e2ePort}`,
	},
});
