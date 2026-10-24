/**
 * 精度ゲートの照合のコマンド(設計書 §3.4)。CIの単体試験と同じcheckGateを、
 * 手元からのstagingのデプロイ(apps/worker/scripts/deploy-staging.mjs)の前に走らせる。
 * 本物のAIは呼ばない(記録とファイルを読むだけ)。
 * 引数でリポジトリのルートを渡せる(試験用。省略時はこのリポジトリ)。
 * 終了コード: 0=通る・1=通らない
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGate } from "./lib/gate-check";

const repoRoot =
	process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const problems = checkGate(repoRoot);
if (problems.length > 0) {
	console.error("精度ゲートの照合が通りません:");
	for (const p of problems) console.error(`- ${p}`);
	process.exitCode = 1;
} else {
	console.log("精度ゲートの照合: 通りました");
}
