/**
 * Playwright設定(E2EはAPIレベルのみ・ブラウザ不要)。
 * webServerはローカルD1へのマイグレーション適用後にwrangler devを起動する
 * (.dev.varsは事前にscripts/prepare-dev-vars.mjsが生成・docs/04 §4のテスト鍵モード)。
 * --localはwrangler.jsoncのAIバインディングが引き起こすリモートプロキシセッション
 * (アカウント認証が必要)を無効化し、全バインディングをローカルエミュレータで完結
 * させるための指定(CLAUDE.mdの環境方針・CIではトークン不要)。
 * --test-scheduledはCronの強制発火(GET /__scheduled・F3計画Task 14)のための指定で、
 * 付けないとローカルではscheduledハンドラが一度も走らない。
 * clean-e2e-data.mjsは過去回のE2E由来の残置Intentをexpiredへ倒す(パイプラインE2Eの
 * 検索取り出し幅を汚染しないようにするため・スクリプト冒頭コメント参照)。
 * 状態は手元開発と分けた.wrangler/e2e-stateへ置く(手元のD1の残置データでE2Eが壊れず、
 * 手元のD1も変えない・#12)。
 * 統合試験(vitest)とは別の起動経路であり、CIでは既存サーバーの再利用をしない
 */

import { defineConfig } from "@playwright/test";

// 既定8787。ローカルで他プロジェクトが8787を占有する場合は
// `LATCH_E2E_PORT=<空きポート>` を指定(占有されたサーバーを誤再利用しない)。
const e2ePort = process.env.LATCH_E2E_PORT ?? "8787";

// E2E専用のローカル状態の置き場(手元開発のD1=既定の.wrangler/stateとは分ける・#12)。
// D1のマイグレーション・clean-e2e-data.mjs・wrangler devは必ず同じ場所を使う
const e2eState = ".wrangler/e2e-state";

export default defineConfig({
	testDir: "./e2e",
	// 直列実行にする(specファイル間でwrangler devの1プロセス=インメモリの
	// ベクトルストア・Cron発火を共有するため。並列だとパイプラインE2Eの
	// 取得件数の観測が他specのIntent作成と交差して非決定になる・docs/10 §3)
	workers: 1,
	webServer: {
		command: `node scripts/prepare-dev-vars.mjs && wrangler d1 migrations apply DB --local --persist-to ${e2eState} && node scripts/clean-e2e-data.mjs && wrangler dev --local --persist-to ${e2eState} --test-scheduled --port ${e2ePort}`,
		url: `http://localhost:${e2ePort}/healthz`,
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
	},
	use: {
		baseURL: `http://localhost:${e2ePort}`,
	},
});
