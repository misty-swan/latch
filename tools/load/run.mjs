/**
 * k6の実行の包み(F8b設計 §2.1・§3.1)。k6は通信の失敗のときに宛先のURLを
 * そのまま出すため、k6の標準出力・標準エラーをすべてlib/redact.mjsで伏せてから出す。
 * k6の終了コード(閾値を外れると0以外)はそのまま返す。
 *
 * 使い方: LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/run.mjs <シナリオ.js> [k6 runの引数...]
 *   例: node tools/load/run.mjs tools/load/scenarios/a-intent-burst.js -e RUN_ID=202610221530 \
 *         --summary-export tools/load/results/202610221530-a.json
 * k6の場所は環境変数K6_BIN(既定は`k6`=PATHの中)。宛先は`-e LATCH_LOAD_BASE_URL`として渡す。
 * LATCH_ACCESS_CLIENT_ID・LATCH_ACCESS_CLIENT_SECRET(Cloudflare Accessの通行証)があれば
 * 同じく`-e`で渡し、k6の出力に出たときはURLと同じく伏せる。
 */

import { spawn } from "node:child_process";
import { createLineRedactor } from "./lib/redact.mjs";
import { accessHeaders } from "./lib/target.mjs";

const base = (process.env.LATCH_LOAD_BASE_URL || "").replace(/\/+$/, "");
const [scenario, ...k6Args] = process.argv.slice(2);
if (!base) {
	console.error("LATCH_LOAD_BASE_URLが未設定です");
	process.exit(1);
}
if (!scenario) {
	console.error(
		"使い方: node tools/load/run.mjs <シナリオ.js> [k6 runの引数...]",
	);
	process.exit(1);
}

const access = accessHeaders(process.env);
const accessEnvArgs =
	Object.keys(access).length === 0
		? []
		: [
				"-e",
				`LATCH_ACCESS_CLIENT_ID=${process.env.LATCH_ACCESS_CLIENT_ID}`,
				"-e",
				`LATCH_ACCESS_CLIENT_SECRET=${process.env.LATCH_ACCESS_CLIENT_SECRET}`,
			];
const secrets = Object.values(access);

const child = spawn(
	process.env.K6_BIN || "k6",
	[
		"run",
		"-e",
		`LATCH_LOAD_BASE_URL=${base}`,
		...accessEnvArgs,
		...k6Args,
		scenario,
	],
	{ stdio: ["inherit", "pipe", "pipe"] },
);

const out = createLineRedactor(base, (s) => process.stdout.write(s), secrets);
const err = createLineRedactor(base, (s) => process.stderr.write(s), secrets);
child.stdout.setEncoding("utf8").on("data", (c) => out.push(c));
child.stderr.setEncoding("utf8").on("data", (c) => err.push(c));

// Ctrl+Cは端末からk6にも直接届く。包みは先に終わらず、k6が結果をまとめて終わるのを待つ
// (ここでk6へもう1度送ると、k6は2回目の中断として結果をまとめずに止まる)
process.on("SIGINT", () => {});

child.on("error", (e) => {
	console.error(
		`k6を起動できません(${e.code ?? e.name})。K6_BINかPATHを確かめてください`,
	);
	process.exit(1);
});
child.on("close", (code, signal) => {
	out.end();
	err.end();
	process.exit(code ?? (signal ? 1 : 0));
});
