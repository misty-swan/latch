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
 * @param {string} name
 * @param {number} targetMs
 * @param {Array<number | null>} durations
 */
export function summarize(name, targetMs, durations) {
	const measuredValues = durations.filter((d) => d !== null);
	const p95Ms = p95(measuredValues);
	return {
		name,
		targetMs,
		total: durations.length,
		measured: measuredValues.length,
		missing: durations.length - measuredValues.length,
		p95Ms,
		pass: p95Ms === null ? null : p95Ms <= targetMs,
	};
}

/**
 * 初期判定の所要時間(有効化→Push送信試行)。
 * @param {Array<{ activatedAt: number, pushAttemptedAt: number | null }>} rows
 * @returns {Array<number | null>}
 */
export function judgeDurations(rows) {
	return rows.map((r) =>
		r.pushAttemptedAt === null ? null : r.pushAttemptedAt - r.activatedAt,
	);
}

/**
 * 通知の所要時間(通知作成→Push送信試行)。
 * @param {Array<{ createdAt: number, pushAttemptedAt: number | null }>} rows
 * @returns {Array<number | null>}
 */
export function notifyDurations(rows) {
	return rows.map((r) =>
		r.pushAttemptedAt === null ? null : r.pushAttemptedAt - r.createdAt,
	);
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
		const verdict = s.pass === null ? "—" : s.pass ? "合格" : "不合格";
		lines.push(
			`| ${s.name} | ${sec(s.targetMs)} | ${s.total} | ${s.measured} | ${s.missing} | ${p} | ${verdict} |`,
		);
	}
	return lines.join("\n");
}
