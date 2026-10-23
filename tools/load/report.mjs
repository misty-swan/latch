/**
 * 負荷試験の集計(F8b設計 §4.1)。k6の結果(`tools/load/results/<runId>-a.json`・`-c.json`)と、
 * stagingのD1への読み取りの問い合わせ(SELECTのみ)から、01 §20の目標ごとのp95をMarkdownの表で
 * 標準出力へ出す。結果のファイルやD1の行が無い項目は「計測なし」とする。
 * 初期判定・通知・Candidate Retrievalは(b)(d)の利用者の行で測るため、後始末(cleanup.mjs)で
 * 意思を消す前に実行する(意思を消すとその意思のmatch_eventsの行も消える)。
 *
 * 使い方: node tools/load/report.mjs <runId>
 * stagingのURLは使わない。wranglerの出力に混じるworkers.devのURLは伏せる(設計 §2.1)。
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	parseJsonOutput,
	redactUrls,
	wranglerOk,
} from "../../apps/worker/scripts/lib/wrangler-cli.mjs";
import { k6Row, readK6Metrics, renderChatTable } from "./lib/k6summary.mjs";
import {
	buildQueries,
	notifyFromRows,
	reflectionBreakdown,
	reflectionFromRows,
	retrievalFromRows,
	splitJudgeRows,
} from "./lib/queries.mjs";
import { renderReferenceTable, renderTable, summarize } from "./lib/stats.mjs";

/** 01 §20の目標(ミリ秒) */
const TARGET_MS = {
	intentSave: 500,
	parser: 3000,
	retrieval: 1000,
	judge: 10000,
	notify: 5000,
};

/**
 * 報告の本文を組み立てる(純粋関数)
 * @param {string} runId
 * @param {{ a: object | null, c: object | null }} k6 シナリオごとのk6の結果(無ければnull)
 * @param {{ judge: object[], notify: object[], retrieval: object[], reflection?: object[] }} rows D1の行
 * @returns {string}
 */
export function buildReport(runId, k6, rows) {
	const m = readK6Metrics(k6);
	const retrieval = retrievalFromRows(rows.retrieval);
	const judge = splitJudgeRows(rows.judge);
	const reflectionRows = rows.reflection ?? [];
	const breakdown = reflectionBreakdown(reflectionRows);
	const table = renderTable([
		k6Row("Intent保存", TARGET_MS.intentSave, m.intentSaveP95),
		k6Row("Parser(stub)", TARGET_MS.parser, m.parseP95),
		summarize("Candidate Retrieval", TARGET_MS.retrieval, retrieval.durations),
		summarize(
			"初期判定(相手が先に反映済み)",
			TARGET_MS.judge,
			judge.preReflected,
		),
		summarize("通知", TARGET_MS.notify, notifyFromRows(rows.notify)),
	]);
	const found = ["a", "c"]
		.map((s) => `(${s}) ${k6[s] === null ? "なし" : "あり"}`)
		.join("・");
	return [
		`## 負荷試験の集計(実行の印 ${runId})`,
		"",
		table,
		"",
		renderChatTable(m),
		"",
		renderReferenceTable([
			{ name: "初期判定(同時・参考)", durations: judge.simultaneous },
			{
				name: "Vectorizeの反映",
				durations: reflectionFromRows(reflectionRows),
			},
		]),
		"",
		`- k6の結果のファイル: ${found}。Intent保存・Parserは(a)、チャットは(c)の結果から読む(k6のsummaryはp95だけを持つため、件数の欄は—)`,
		"- Candidate Retrieval・初期判定・通知は、stagingのD1の(b)(d)の利用者の行から集計する。「欠け」は計測できなかった件数(提案の通知が無い・送信試行が無い・イベント行が無い)。欠けが1件でもあれば、計測した分のp95が目標以内でも判定は「—(欠けあり)」(合格としない)。目標を超えれば欠けがあっても不合格",
		`- embedding_completedのイベント行が無い意思: ${retrieval.withoutEvent}件(埋め込みを毎分Cronのバックフィルで行った意思はこの行を持たず、Candidate Retrievalの欠けになる)`,
		"- Vectorizeの反映は、意思のversionごとの反映確認の行(vector_reflection)の作成から反映の確認までの時間である。01 §20に目標値は無く、合否は付けず実測だけを出す。「欠け」は確認できず諦めた(failed)・古い版などで値の無い行の数。内訳のskippedは、意思が無い・古い版・activeでないために反映を確かめずに処理済みにした行(payload.skipped)の数",
		`- Vectorizeの反映の欠けの内訳: skipped ${breakdown.skipped}件・failed ${breakdown.failed}件・その他 ${breakdown.other}件`,
		"- 初期判定は、組の相手の意思の反映確認(vector_reflection)が反映を確かめてprocessedになった時刻(payload.skippedが無いかnot_evaluatedの行。not_found・stale_version・inactiveは反映を確かめていないため除く)と、自分の有効化(intent_created)の行の作成時刻を比べて振り分ける。相手の反映が自分の有効化より前(同時刻は含めない)なら「相手が先に反映済み」で、これだけに目標(p95 10秒・01 §20)の合否を付ける。それ以外((d)の組・先に保存した側・相手が未反映のとき)は「同時」で、合否を付けない参考値である。(b)は片方が先に保存して反映を確かめてからもう片方が保存するため、後から保存した側が「相手が先に反映済み」の標本になる",
		"- 初期判定の起点は有効化のイベント行(intent_created)の作成時刻で、有効化の保存の直後に応答の後の処理(waitUntil)で書かれる。保存のコミットよりわずかに後の時刻を起点にしている",
		"- 送信記録(push_attempted_at)は送信の順番を取った時刻である。試験用の利用者は購読を持たないためno_subscriptionで確定し、暗号化と送信の時間は含まれない",
		"- Parser・初期判定の行はLLMをstubで動かした値である(Parser・Jev)",
	].join("\n");
}

/** k6の結果のファイルを読む。無ければnull */
function readSummary(runId, scenario) {
	const path = new URL(`./results/${runId}-${scenario}.json`, import.meta.url);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		console.error(`report: ${runId}-${scenario}.json をJSONとして読めません`);
		return null;
	}
}

/** stagingのD1へ読み取りの問い合わせを送り、結果の行を返す */
function queryRows(sql) {
	const r = wranglerOk([
		"d1",
		"execute",
		"DB",
		"--env",
		"staging",
		"--remote",
		"--json",
		"--command",
		sql,
	]);
	const out = parseJsonOutput(r.stdout);
	const rows = Array.isArray(out) ? out[0]?.results : out?.results;
	return Array.isArray(rows) ? rows : [];
}

function main() {
	const runId = process.argv[2];
	const sql = buildQueries(runId);
	const k6 = { a: readSummary(runId, "a"), c: readSummary(runId, "c") };
	const rows = {
		judge: queryRows(sql.judge),
		notify: queryRows(sql.notify),
		retrieval: queryRows(sql.retrieval),
		reflection: queryRows(sql.reflection),
	};
	console.log(buildReport(runId, k6, rows));
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main();
	} catch (e) {
		console.error(`report: ${redactUrls(String(e?.message ?? e))}`);
		process.exit(1);
	}
}
