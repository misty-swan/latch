/**
 * wranglerの呼び出し部(staging用スクリプトの共有・F8b設計 §1.2・§2.2)。
 * `pnpm exec wrangler`をapps/workerで実行し、標準出力を文字列で返す。
 */

import { spawnSync } from "node:child_process";
import { workerDir } from "./test-fixtures.mjs";

/** workers.devのURLを伏せる(stagingのURLはログに残さない・F8b設計 §2.1) */
export const redactUrls = (text) =>
	text.replace(/https?:\/\/[^\s"']*workers\.dev[^\s"']*/g, "<url伏せ>");

/**
 * wranglerを実行して{status, stdout, stderr}を返す(出力は伏せ処理済み)。
 * inputを渡すと標準入力へ流す(シークレットの値用。値は出力に出ない)
 */
export function wrangler(args, { input } = {}) {
	const r = spawnSync("pnpm", ["exec", "wrangler", ...args], {
		cwd: workerDir,
		input,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
	});
	return {
		status: r.status ?? 1,
		stdout: redactUrls(r.stdout ?? ""),
		stderr: redactUrls(r.stderr ?? ""),
	};
}

/** wranglerを実行し、失敗(非0)なら出力を添えて例外にする */
export function wranglerOk(args, opts) {
	const r = wrangler(args, opts);
	if (r.status !== 0) {
		throw new Error(
			`wrangler ${args.slice(0, 3).join(" ")} が失敗しました(終了コード${r.status})\n${r.stdout}\n${r.stderr}`,
		);
	}
	return r;
}

/** 出力の最初の[または{からJSONとして読む(先頭のバナー行を読み飛ばす) */
export function parseJsonOutput(text) {
	const i = text.search(/[[{]/);
	if (i < 0) throw new Error("JSONの出力が見つかりません");
	return JSON.parse(text.slice(i));
}
