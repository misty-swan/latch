/**
 * stagingへの手元デプロイ(F8b設計 §2.2・CIと同じ手順)。どれかが失敗したらそこで止まる:
 *   1. VITE_DEV_AUTH=1 pnpm --filter web build(テスト用サインイン画面を含める)
 *   2. wrangler d1 migrations apply DB --env staging --remote
 *   3. wrangler deploy --env staging
 *   4. staging-smoke.mjs(LATCH_STAGING_URLが必要。URLは出力しない)
 * wranglerの出力にworkers.devのURLが含まれても伏せて表示する。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactUrls } from "./lib/wrangler-cli.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(scriptsDir, "..");
const repoRoot = path.join(workerDir, "..", "..");

/** 1段を実行し、失敗なら終了する。出力は伏せ処理を通して表示する */
function step(label, cmd, args, { cwd, env } = {}) {
	console.log(`\n== ${label}`);
	const r = spawnSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	process.stdout.write(redactUrls(r.stdout ?? ""));
	process.stderr.write(redactUrls(r.stderr ?? ""));
	if (r.status !== 0) {
		console.error(`失敗: ${label}(終了コード${r.status ?? "不明"})`);
		process.exit(r.status || 1);
	}
}

step("webのビルド(VITE_DEV_AUTH=1)", "pnpm", ["--filter", "web", "build"], {
	cwd: repoRoot,
	env: { VITE_DEV_AUTH: "1" },
});
step(
	"D1マイグレーション適用(staging・remote)",
	"pnpm",
	[
		"exec",
		"wrangler",
		"d1",
		"migrations",
		"apply",
		"DB",
		"--env",
		"staging",
		"--remote",
	],
	{ cwd: workerDir },
);
step(
	"Workerのデプロイ(staging)",
	"pnpm",
	["exec", "wrangler", "deploy", "--env", "staging"],
	{ cwd: workerDir },
);
step("疎通確認", "node", [path.join(scriptsDir, "staging-smoke.mjs")], {
	cwd: workerDir,
});
console.log("\nstagingへのデプロイが完了しました");
