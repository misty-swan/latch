/**
 * prodへの手元デプロイ(F10・docs/11 §2・docs/runbooks/prod.md 5章・CIのdeploy-prodと同じ手順)。
 * 公開前はプロダクトオーナーの操作(docs/04 §6)。どれかが失敗したらそこで止まる:
 *   0. VITE_DEV_AUTHが立っていたら止める(テスト用サインインの画面をprodのビルドに入れない)
 *   1. 精度ゲートの照合(tools/eval/check-gate.ts・CIの単体試験と同じcheckGate)
 *   2. varsとシークレットの名前の点検(check-prod-secrets.mjs・テスト鍵の残存と必須の欠落)
 *   3. pnpm --filter web build(VITE_DEV_AUTHを外して実行する)
 *   4. wrangler d1 migrations apply DB --env production --remote
 *   5. wrangler deploy --env production
 *   6. prod-smoke.mjs(LATCH_PROD_URLがあるとき。URLは出力しない)
 * wranglerの出力にworkers.devのURLが含まれても伏せて表示する。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactUrls } from "./lib/wrangler-cli.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(scriptsDir, "..");
const repoRoot = path.join(workerDir, "..", "..");

/** VITE_DEV_AUTHとLATCH_PROD_URLを除いた環境(ビルドと点検に渡す) */
const { VITE_DEV_AUTH, LATCH_PROD_URL, ...baseEnv } = process.env;

/** 1段を実行し、失敗なら終了する。出力は伏せ処理を通して表示する */
function step(label, cmd, args, { cwd } = {}) {
	console.log(`\n== ${label}`);
	const r = spawnSync(cmd, args, { cwd, env: baseEnv, encoding: "utf8" });
	process.stdout.write(redactUrls(r.stdout ?? ""));
	process.stderr.write(redactUrls(r.stderr ?? ""));
	if (r.status !== 0) {
		console.error(`失敗: ${label}(終了コード${r.status ?? "不明"})`);
		process.exit(r.status || 1);
	}
}

if (VITE_DEV_AUTH !== undefined && VITE_DEV_AUTH !== "") {
	console.error(
		"デプロイを止めました: VITE_DEV_AUTHが設定されています。prodはテスト用サインインの画面を出さないため、外してから実行してください",
	);
	process.exit(1);
}

step(
	"精度ゲートの照合",
	"pnpm",
	["--filter", "eval", "exec", "tsx", "check-gate.ts"],
	{ cwd: repoRoot },
);
step(
	"varsとシークレットの名前の点検",
	"node",
	[path.join(scriptsDir, "check-prod-secrets.mjs")],
	{ cwd: workerDir },
);
step(
	"webのビルド(テスト用サインインなし)",
	"pnpm",
	["--filter", "web", "build"],
	{
		cwd: repoRoot,
	},
);
step(
	"D1マイグレーション適用(production・remote)",
	"pnpm",
	[
		"exec",
		"wrangler",
		"d1",
		"migrations",
		"apply",
		"DB",
		"--env",
		"production",
		"--remote",
	],
	{ cwd: workerDir },
);
step(
	"Workerのデプロイ(production)",
	"pnpm",
	["exec", "wrangler", "deploy", "--env", "production"],
	{ cwd: workerDir },
);
if (LATCH_PROD_URL) {
	console.log("\n== 疎通確認");
	const r = spawnSync("node", [path.join(scriptsDir, "prod-smoke.mjs")], {
		cwd: workerDir,
		stdio: "inherit",
	});
	if (r.status !== 0) {
		console.error(
			"失敗: 疎通確認。戻すときは手順書 8章(wrangler rollback --env production)",
		);
		process.exit(r.status || 1);
	}
} else {
	console.log(
		"\n疎通確認は飛ばしました(LATCH_PROD_URLが未設定。独自ドメインの設定後に手順書 5.3で行う)",
	);
}
console.log("\nprodへのデプロイが完了しました");
