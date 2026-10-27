/**
 * staging用Cloudflare資源の作成(F8b設計 §1.2・docs/04 §6)。何度実行しても同じ結果になる:
 * 既にある資源は作らずIDを読み出し、無いものだけ作る(本体はlib/provision.mjs)。
 *   node scripts/provision-staging.mjs            # 無いものを作り、IDを表示
 *   node scripts/provision-staging.mjs --dry-run  # 作らず、作る予定だけ表示(読み取りのみ)
 *   node scripts/provision-staging.mjs --write     # IDをwrangler.jsoncのenv.stagingへ書き込む
 * 資源名は-staging付き(既存資源に触れない)。IDは秘密ではないためコミットしてよい。
 */

import { provision } from "./lib/provision.mjs";

provision({
	envName: "staging",
	names: {
		d1: "latch-db-staging",
		kvRevocation: "latch-revocation-staging",
		kvPipeline: "latch-pipeline-staging",
		r2: "latch-icons-staging",
		vectorize: "latch-intents-staging",
		queues: ["match-events-staging", "match-events-dlq-staging"],
	},
	argv: process.argv,
});
