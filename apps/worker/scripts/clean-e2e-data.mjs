/**
 * E2E起動前の残置データ後始末(worker E2EのwebServerチェーンで実行)。
 * 過去回のE2Eで作成され後始末されなかったIntent(失敗時に残る)をexpiredへ倒し、
 * マッチングパイプラインE2Eの観測対象から外す。
 *
 * なぜ必要か: ローカルD1は実行間で永続する(helpers.tsの汚染回避コメント参照)。
 * activeのまま残ったIntentは、パイプラインE2EがGET /__scheduledでCronを発火した
 * 項に埋め込みバックフィル(docs/06 §2(e))でベクトル化され、検索取り出し幅
 * (topK=100)を汚染して観測を非決定にする。対象はE2Eユーザー(subjectの接頭辞
 * e2e-・apps/worker/e2e/helpers.tsとapps/web/e2e/helpers.tsの両方)に限定するため、
 * 手元開発で作ったデータには触れない。CIは常に空のD1から始まるため効果は同一
 *
 * 実行タイミング: マイグレーション適用の後(webServerのcommandチェーン内)と、
 * latches.spec.ts・group-latches.spec.tsの各testの前(wrangler dev起動中)。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// E2E専用のローカル状態の置き場(playwright.config.tsのwebServerと同じ場所・手元開発のD1には触れない)
const e2eState = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	".wrangler",
	"e2e-state",
);

const command =
	"UPDATE intents SET status = 'expired' WHERE status = 'active' AND user_id IN (SELECT id FROM users WHERE auth_subject LIKE 'e2e-%')";

/**
 * ロック競合の再試行(有界)。spec途中の呼び出しでは起動中のwrangler dev(キュー消費・Cron)が
 * 同じローカルD1ファイルへ書き込んでおり、`wrangler d1 execute --local` が
 * `database is locked: SQLITE_BUSY` で失敗することがある(待たずに即失敗する)。
 * ロック競合だけを最大 MAX_ATTEMPTS 回まで間隔を伸ばして再試行し、それ以外の失敗・
 * 回数超過はそのまま非0で終了する(本物の失敗を隠さない)
 */
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 2_000;
const LOCKED = /SQLITE_BUSY|database is locked/;

const sleepSync = (ms) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

for (let attempt = 1; ; attempt++) {
	const result = spawnSync(
		"wrangler",
		[
			"d1",
			"execute",
			"DB",
			"--local",
			"--persist-to",
			e2eState,
			"--command",
			command,
		],
		{ encoding: "utf8", shell: process.platform === "win32" },
	);
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (result.status === 0) {
		process.stdout.write(stdout);
		process.stderr.write(stderr);
		break;
	}
	const locked = LOCKED.test(stdout) || LOCKED.test(stderr);
	if (!locked || attempt >= MAX_ATTEMPTS) {
		process.stdout.write(stdout);
		process.stderr.write(stderr);
		if (result.error !== undefined) {
			process.stderr.write(`${String(result.error)}\n`);
		}
		process.exit(result.status ?? 1);
	}
	const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
	process.stderr.write(
		`clean-e2e-data: ローカルD1のロック競合(SQLITE_BUSY)のため${delay}ms後に再試行します(${attempt}/${MAX_ATTEMPTS})\n`,
	);
	sleepSync(delay);
}
