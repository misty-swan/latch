/**
 * ブラウザE2Eの設定(Playwright/chromium・F2'計画Task 8)。
 * webServerは1コマンドで「vite build → .dev.vars生成 → D1マイグレーション →
 * wrangler dev(apps/worker側のwrangler.jsoncでAssets+API同一ポート)」まで行う。
 * - ビルドはVITE_DEV_AUTH=1付きで行う(テストサインインUIは本番ビルドでは出ないため・
 *   docs/04 §4のテスト鍵。E2Eとローカル開発だけがdevサインインを使う)
 * - --localは全バインディングをローカルエミュレータで完結させる指定
 *   (apps/worker/playwright.config.tsと同じ理由・CIではCloudflareアカウント不要)
 * - ポートは既定8788(worker E2Eの既定8787と分離・CIでは別ジョブ)。
 *   LATCH_E2E_PORTで上書きできる(占有されたサーバーを誤再利用・停止しないための逃し道)
 */

import { defineConfig } from "@playwright/test";

const e2ePort = process.env.LATCH_E2E_PORT ?? "8788";

export default defineConfig({
	testDir: "./e2e",
	reporter: process.env.CI ? "dot" : "list",
	webServer: {
		command: `VITE_DEV_AUTH=1 pnpm --filter web build && pnpm --filter worker exec node scripts/prepare-dev-vars.mjs && pnpm --filter worker exec wrangler d1 migrations apply DB --local && pnpm --filter worker exec wrangler dev --local --port ${e2ePort}`,
		url: `http://localhost:${e2ePort}/healthz`,
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
		// ビルドとwrangler devの起動を合わせて数10秒〜(CIの冷えたキャッシュでも待てる上限)
		timeout: 180_000,
	},
	use: {
		baseURL: `http://localhost:${e2ePort}`,
	},
});
