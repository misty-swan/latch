/**
 * prod用Cloudflare資源の作成(F10・docs/04 §6・docs/runbooks/prod.md 2章)。何度実行しても
 * 同じ結果になる: 既にある資源は作らずIDを読み出し、無いものだけ作る(本体はlib/provision.mjs)。
 *   node scripts/provision-prod.mjs            # 無いものを作り、IDを表示
 *   node scripts/provision-prod.mjs --dry-run  # 作らず、作る予定だけ表示(読み取りのみ)
 *   node scripts/provision-prod.mjs --write     # IDをwrangler.jsoncのenv.productionへ書き込む
 * 資源名は-production付き(stagingや既存資源に触れない)。IDは秘密ではないためコミットしてよい。
 * Analytics Engineのデータセット(latch_metrics_production)は初回のデプロイで自動で作られる。
 */

import { provision } from "./lib/provision.mjs";

provision({
	envName: "production",
	names: {
		d1: "latch-db-production",
		kvRevocation: "latch-revocation-production",
		kvPipeline: "latch-pipeline-production",
		r2: "latch-icons-production",
		vectorize: "latch-intents-production",
		queues: ["match-events-production", "match-events-dlq-production"],
	},
	argv: process.argv,
});
