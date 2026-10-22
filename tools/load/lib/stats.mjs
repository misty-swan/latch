// 負荷試験の集計の計算部(純粋関数)。時間の単位はすべてミリ秒。

/**
 * p95(最近順位法)。昇順に並べ、ceil(0.95 × n) − 1 番目(0始まり)。n=0はnull。
 * @param {number[]} values
 * @returns {number | null}
 */
export function p95(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/**
 * 1項目の集計。durationsのnullは「計測できなかった1件」(欠け)。
 * 判定(pass): 計測したp95が目標を超えれば欠けの有無によらずfalse(不合格)。
 * 目標以内でも欠けが1件でもあればnull(欠けた分が遅かった可能性を否定できず、合格と言えない)。
 * 計測が0件でもnull。所要時間の行の組み立てはqueries.mjs(judgeFromRows・notifyFromRows)
 * @param {string} name
 * @param {number} targetMs
 * @param {Array<number | null>} durations
 */
export function summarize(name, targetMs, durations) {
	const measuredValues = durations.filter((d) => d !== null);
	const p95Ms = p95(measuredValues);
	const missing = durations.length - measuredValues.length;
	let pass;
	if (p95Ms === null) pass = null;
	else if (p95Ms > targetMs) pass = false;
	else pass = missing > 0 ? null : true;
	return {
		name,
		targetMs,
		total: durations.length,
		measured: measuredValues.length,
		missing,
		p95Ms,
		pass,
	};
}

/**
 * 分位(最近順位法)。q=0.5でp50。n=0はnull
 * @param {number[]} values
 * @param {number} q
 */
function quantile(values, q) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

const sec = (ms) => `${(ms / 1000).toFixed(2)}秒`;

/**
 * Markdownの表にする。
 * @param {ReturnType<typeof summarize>[]} summaries
 * @returns {string}
 */
export function renderTable(summaries) {
	const lines = [
		"| 項目 | 目標 | 対象 | 計測 | 欠け | p95 | 判定 |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const s of summaries) {
		const p = s.p95Ms === null ? "計測なし" : sec(s.p95Ms);
		// 欠けの欄が数(k6の行は「—」)で1以上なら、判定の保留を「—(欠けあり)」と出す
		const hasMissing = typeof s.missing === "number" && s.missing > 0;
		let verdict;
		if (s.pass === true) verdict = "合格";
		else if (s.pass === false) verdict = "不合格";
		else verdict = hasMissing && s.p95Ms !== null ? "—(欠けあり)" : "—";
		lines.push(
			`| ${s.name} | ${sec(s.targetMs)} | ${s.total} | ${s.measured} | ${s.missing} | ${p} | ${verdict} |`,
		);
	}
	return lines.join("\n");
}

/**
 * 目標値の無い参考項目の行(件数・欠け・p50・p95・最大。合否なし)。nullは欠け
 * @param {string} name
 * @param {Array<number | null>} durations
 */
export function renderReferenceTable(name, durations) {
	const values = durations.filter((d) => d !== null);
	const cell = (v) => (v === null ? "計測なし" : sec(v));
	return [
		"| 項目(参考) | 件数 | 欠け | p50 | p95 | 最大 |",
		"| --- | --- | --- | --- | --- | --- |",
		`| ${name} | ${durations.length} | ${durations.length - values.length} | ${cell(quantile(values, 0.5))} | ${cell(p95(values))} | ${cell(values.length === 0 ? null : Math.max(...values))} |`,
	].join("\n");
}
