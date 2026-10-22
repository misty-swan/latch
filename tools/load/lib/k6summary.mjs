// k6の結果(--summary-exportのJSON)の読み取り(F8b設計 §4.1・純粋関数)。
// 時間の指標(Trend)は各シナリオのsummaryTrendStatsにより`p(95)`の鍵を持つ。
// 割合の指標(Rate)は`passes`=値が真(0以外)の数・`fails`=偽の数を持つ。

/** 数(有限)ならその値、そうでなければnull */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const metric = (summary, name) => summary?.metrics?.[name] ?? null;

/**
 * (a)と(c)の結果から集計に使う値を取り出す。ファイルが無いシナリオはnullを渡す
 * @param {{ a: object | null, c: object | null }} summaries
 */
export function readK6Metrics({ a, c }) {
	const connect = metric(c, "chat_connect_failed");
	const failed = num(connect?.passes);
	const ok = num(connect?.fails);
	return {
		intentSaveP95: num(
			metric(a, "http_req_duration{name:intent_save}")?.["p(95)"],
		),
		parseP95: num(metric(a, "http_req_duration{name:parse}")?.["p(95)"]),
		chatDeliveryP95: num(metric(c, "chat_delivery_ms")?.["p(95)"]),
		chatConnect:
			failed === null || ok === null ? null : { failed, total: failed + ok },
	};
}

/**
 * k6が測った項目の1行(renderTableへ渡す形)。k6のsummaryは件数を持たないため件数の欄は—
 * @param {string} name
 * @param {number} targetMs
 * @param {number | null} p95Ms
 */
export function k6Row(name, targetMs, p95Ms) {
	return {
		name,
		targetMs,
		total: "—",
		measured: "—",
		missing: "—",
		p95Ms,
		pass: p95Ms === null ? null : p95Ms <= targetMs,
	};
}

/**
 * チャットの参考値の表(01 §20に目標値は無い)
 * @param {{ chatDeliveryP95: number | null, chatConnect: { failed: number, total: number } | null }} m
 */
export function renderChatTable({ chatDeliveryP95, chatConnect }) {
	const delivery =
		chatDeliveryP95 === null
			? "計測なし"
			: `${(chatDeliveryP95 / 1000).toFixed(2)}秒`;
	const connect =
		chatConnect === null || chatConnect.total === 0
			? "計測なし"
			: `${chatConnect.failed}/${chatConnect.total}(${((chatConnect.failed / chatConnect.total) * 100).toFixed(2)}%)`;
	return [
		"| 項目(参考) | 値 |",
		"| --- | --- |",
		`| チャット 送信→到着 p95 | ${delivery} |`,
		`| チャット 接続の失敗 | ${connect} |`,
	].join("\n");
}
