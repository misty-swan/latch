// k6の結果(--summary-exportのJSON)の読み取り(F8b設計 §4.1・純粋関数)。
// 時間の指標(Trend)は各シナリオのsummaryTrendStatsにより`p(95)`の鍵を持つ。
// 割合の指標(Rate)は`passes`=値が真(0以外)の数・`fails`=偽の数を持つ。

/** 数(有限)ならその値、そうでなければnull */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const metric = (summary, name) => summary?.metrics?.[name] ?? null;

/** 閉じた理由のコード別の件数。鍵は`chat_close_code{code:<コード>}`(k6のサブ指標)。無ければnull */
function closeCodes(c) {
	const out = {};
	for (const [key, value] of Object.entries(c?.metrics ?? {})) {
		const m = /^chat_close_code\{code:(.+)\}$/.exec(key);
		const count = num(value?.count);
		if (m && count !== null) out[m[1]] = count;
	}
	return Object.keys(out).length === 0 ? null : out;
}

/**
 * (a)と(c)の結果から集計に使う値を取り出す。ファイルが無いシナリオはnullを渡す
 * @param {{ a: object | null, c: object | null }} summaries
 */
export function readK6Metrics({ a, c }) {
	const connect = metric(c, "chat_connect_failed");
	const failed = num(connect?.passes);
	const ok = num(connect?.fails);
	const earlyCount = num(metric(c, "chat_closed_early")?.count);
	const holdMetric = metric(c, "chat_hold_ms");
	return {
		intentSaveP95: num(
			metric(a, "http_req_duration{name:intent_save}")?.["p(95)"],
		),
		parseP95: num(metric(a, "http_req_duration{name:parse}")?.["p(95)"]),
		chatDeliveryP95: num(metric(c, "chat_delivery_ms")?.["p(95)"]),
		chatConnect:
			failed === null || ok === null ? null : { failed, total: failed + ok },
		// 途中で閉じた接続・閉じた理由のコード別の件数・保持時間の最小とp50(#46)
		chatClosedEarly: earlyCount,
		chatCloseCodes: closeCodes(c),
		chatHold:
			num(holdMetric?.min) === null
				? null
				: { minMs: num(holdMetric.min), medMs: num(holdMetric.med) },
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
export function renderChatTable({
	chatDeliveryP95,
	chatConnect,
	chatClosedEarly = null,
	chatCloseCodes = null,
	chatHold = null,
}) {
	const delivery =
		chatDeliveryP95 === null
			? "計測なし"
			: `${(chatDeliveryP95 / 1000).toFixed(2)}秒`;
	const connect =
		chatConnect === null || chatConnect.total === 0
			? "計測なし"
			: `${chatConnect.failed}/${chatConnect.total}(${((chatConnect.failed / chatConnect.total) * 100).toFixed(2)}%)`;
	const sec = (ms) =>
		ms === null ? "計測なし" : `${(ms / 1000).toFixed(2)}秒`;
	const early = chatClosedEarly === null ? "計測なし" : `${chatClosedEarly}件`;
	const codes =
		chatCloseCodes === null
			? "計測なし"
			: Object.entries(chatCloseCodes)
					.sort(([a], [b]) => Number(a) - Number(b))
					.map(([code, n]) => `${code}: ${n}件`)
					.join("・");
	return [
		"| 項目(参考) | 値 |",
		"| --- | --- |",
		`| チャット 送信→到着 p95 | ${delivery} |`,
		`| チャット 接続の失敗 | ${connect} |`,
		`| チャット 途中で閉じた接続 | ${early} |`,
		`| チャット 閉じた理由のコード別 | ${codes} |`,
		`| チャット 保持時間 最小 | ${sec(chatHold?.minMs ?? null)} |`,
		`| チャット 保持時間 p50 | ${sec(chatHold?.medMs ?? null)} |`,
	].join("\n");
}
