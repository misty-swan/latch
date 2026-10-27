/**
 * prodにテスト鍵が残っていないことの点検(F10・docs/11 §1・LAT-122・docs/runbooks/prod.md 6章)。
 * 読み取りだけで、何も変えない。
 *   1. wrangler.jsoncのenv.productionのvarsと、`wrangler secret list --env production`の
 *      名前の一覧を照らし合わせる(判定はsrc/ops/prod-checks.ts・workerの試験で確かめる)。
 *      テスト用IdP鍵などの起動ガードが拒む名前の残存と、必須のシークレットの欠落を問題とする
 *   2. LATCH_PROD_URLがあれば疎通確認(prod-smoke.mjs)も行う。GET /healthzの200で起動ガードを
 *      通った(テスト用VAPID鍵も入っていない)こと、POST /v1/dev/idp-tokenの404を確かめる
 * 問題が1つでもあれば非0で終わる。表示するのは名前だけで、値とURLは出さない。
 *   node scripts/check-prod-secrets.mjs
 *   LATCH_PROD_URL=<prodのURL> node scripts/check-prod-secrets.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { checkProdConfig, secretNamesOf } from "../src/ops/prod-checks.ts";
import { parseJsonOutput, wranglerOk } from "./lib/wrangler-cli.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const config = parse(
	readFileSync(path.join(scriptsDir, "..", "wrangler.jsonc"), "utf8"),
);
const vars = config.env?.production?.vars;
if (!vars) {
	console.error("wrangler.jsoncにenv.productionのvarsがありません");
	process.exit(1);
}

const names = secretNamesOf(
	parseJsonOutput(
		wranglerOk(["secret", "list", "--env", "production", "--format", "json"])
			.stdout,
	),
);
console.log(`登録済みのシークレット(${names.length}件): ${names.join("・")}`);

const { problems, notes } = checkProdConfig(vars, names);
for (const p of problems) console.error(`NG: ${p}`);
for (const n of notes) console.log(`注意: ${n}`);
if (problems.length === 0) console.log("OK: varsとシークレットの名前");

let smokeOk = true;
if (process.env.LATCH_PROD_URL) {
	const r = spawnSync("node", [path.join(scriptsDir, "prod-smoke.mjs")], {
		stdio: "inherit",
	});
	smokeOk = r.status === 0;
} else {
	console.log(
		"疎通確認は飛ばしました(LATCH_PROD_URLが未設定)。テスト用VAPID鍵の混入は疎通確認で確かめます",
	);
}

process.exit(problems.length === 0 && smokeOk ? 0 : 1);
