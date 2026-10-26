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

// E2E専用のローカル状態の置き場(apps/workerの.wrangler/e2e-state・手元開発のD1とは分ける・#12)。
// worker側のplaywright.config.ts・clean-e2e-data.mjsと同じ場所
const e2eState = ".wrangler/e2e-state";

export default defineConfig({
	testDir: "./e2e",
	// 直列実行にする(latch-flow.spec.tsは提案のパイプラインを通し・各testの前後で
	// E2EユーザーのactiveなIntentをexpiredへ倒す。並列だとflow.spec.tsの地域なしIntentが
	// 提案の相手に混ざり・後始末がflow.spec.tsの保存直後のIntentまで倒すため・F4c計画Task 8)
	workers: 1,
	reporter: process.env.CI ? "dot" : "list",
	webServer: {
		command: `VITE_DEV_AUTH=1 pnpm --filter web build && pnpm --filter worker exec node scripts/prepare-dev-vars.mjs && pnpm --filter worker exec wrangler d1 migrations apply DB --local --persist-to ${e2eState} && pnpm --filter worker exec wrangler dev --local --persist-to ${e2eState} --port ${e2ePort}`,
		url: `http://localhost:${e2ePort}/healthz`,
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
		// ビルドとwrangler devの起動を合わせて数10秒〜(CIの冷えたキャッシュでも待てる上限)
		timeout: 180_000,
	},
	use: {
		baseURL: `http://localhost:${e2ePort}`,
		// 既定はiPhoneの大きさ(各specはスマホの画面を前提に書いている)。PCの幅(LAT-14の外枠)は
		// desktop-layout.spec.tsが大きさを指定して確かめる
		viewport: { width: 390, height: 844 },
	},
});
