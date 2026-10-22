/**
 * コマンドを実行し、出力のworkers.devのURLを伏せて表示する(F8b設計 §2.1)。
 * 終了コードはコマンドのものをそのまま返す。CIのstagingへのデプロイの手順で、
 * wranglerが出すURLをシークレットの伏せ字だけに頼らずに伏せるために使う。
 *
 * 使い方: node apps/worker/scripts/run-redacted.mjs <コマンド> [引数...]
 */

import { spawnSync } from "node:child_process";
import { redactUrls } from "./lib/wrangler-cli.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
	console.error("使い方: node run-redacted.mjs <コマンド> [引数...]");
	process.exit(2);
}
const r = spawnSync(cmd, args, {
	encoding: "utf8",
	env: { ...process.env, NO_COLOR: "1" },
	maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(redactUrls(r.stdout ?? ""));
process.stderr.write(redactUrls(r.stderr ?? ""));
if (r.error) {
	console.error(`実行できませんでした(${r.error.name})`);
}
process.exit(r.status ?? 1);
