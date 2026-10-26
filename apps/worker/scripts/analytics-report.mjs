/**
 * Analytics諸量の集計(02 §4 #35・docs/09 §2)。D1へ読み取りの問い合わせ(SELECTのみ)を送り、
 * 候補数・Jev実行回数・LATCH Score・YES/NO・Mutual Latch Rate(形式別)・チャット開始率を
 * Markdownの表で標準出力へ出す。SQLと表の組み立ては src/analytics/report.ts(worker の試験で確かめる)。
 *
 * 使い方: node apps/worker/scripts/analytics-report.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *          [--now <ISO 8601の時刻>] [--persist-to <ローカルの状態の置き場>] [--staging]
 * 期間は日本時間の日付で両端を含む(省略は集計の時刻の日を含む直近30日)。
 * --nowは集計の時刻(チャット開始の判定ができるかの境目・省略は今)で、過去の時点の集計の再現に使う。
 * 既定は手元のD1(`wrangler d1 execute --local`)。--persist-toでE2Eの状態(.wrangler/e2e-state)などを指す。
 * --stagingはstagingのD1(--remote)へ問い合わせる。wranglerの出力に混じるworkers.devのURLは伏せる。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildAnalyticsQueries,
	defaultRange,
	renderAnalyticsReport,
	summarizeAnalytics,
} from "../src/analytics/report.ts";
import {
	parseJsonOutput,
	redactUrls,
	wranglerOk,
} from "./lib/wrangler-cli.mjs";

/** 値を取る引数と、結果の鍵 */
const VALUE_ARGS = {
	"--from": "from",
	"--to": "to",
	"--now": "now",
	"--persist-to": "persistTo",
};

/** 引数を読む(知らない引数は例外) */
export function parseArgs(argv) {
	const out = { staging: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--staging") {
			out.staging = true;
		} else if (a in VALUE_ARGS) {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a}の値がありません`);
			out[VALUE_ARGS[a]] = v;
		} else {
			throw new Error(`知らない引数です: ${a}`);
		}
	}
	if (out.staging && out.persistTo !== undefined) {
		throw new Error("--stagingと--persist-toは同時に指定できません");
	}
	return out;
}

/** D1へ読み取りの問い合わせを送り、結果の行を返す */
function queryRows(sql, target) {
	const where = target.staging
		? ["--env", "staging", "--remote"]
		: [
				"--local",
				...(target.persistTo === undefined
					? []
					: ["--persist-to", path.resolve(target.persistTo)]),
			];
	const r = wranglerOk([
		"d1",
		"execute",
		"DB",
		...where,
		"--json",
		"--command",
		sql,
	]);
	const out = parseJsonOutput(r.stdout);
	const rows = Array.isArray(out) ? out[0]?.results : out?.results;
	return Array.isArray(rows) ? rows : [];
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const nowMs = args.now === undefined ? Date.now() : Date.parse(args.now);
	if (!Number.isSafeInteger(nowMs)) {
		throw new Error(`--nowはISO 8601の時刻で指定してください: ${args.now}`);
	}
	const base = defaultRange(nowMs);
	const range = {
		from: args.from ?? base.from,
		to: args.to ?? base.to,
		nowMs: base.nowMs,
	};
	const sql = buildAnalyticsQueries(range);
	const rows = Object.fromEntries(
		Object.entries(sql).map(([name, q]) => [name, queryRows(q, args)]),
	);
	console.log(renderAnalyticsReport(range, summarizeAnalytics(rows)));
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main();
	} catch (e) {
		console.error(`analytics-report: ${redactUrls(String(e?.message ?? e))}`);
		process.exit(1);
	}
}
