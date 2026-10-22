// 負荷試験の集計のSQL(F8b設計 §4.1)と、その結果の行から所要時間(ミリ秒)を取り出す部分(純粋関数)。
// 時刻の列はD1の整数のミリ秒(drizzleのtimestamp_ms)。
// 初期判定・通知・Candidate Retrievalは(b)(d)で測る項目のため、実行の印の利用者のうち
// (b)(d)のsubject(`load-<runId>-b<連番>`・`load-<runId>-d<連番>`)だけに絞る。

/** 数(有限)ならその値、そうでなければnull */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 集計のSQLを返す。runIdは12桁の数字のみ(SQLへ文字列として差し込むため、それ以外は例外)
 * @param {string} runId
 * @returns {{ judge: string, notify: string, retrieval: string, reflection: string }}
 */
export function buildQueries(runId) {
	if (typeof runId !== "string" || !/^\d{12}$/.test(runId)) {
		throw new Error("実行の印(runId)は12桁の数字で指定してください");
	}
	const subject = `u.auth_subject LIKE 'load-${runId}-%' AND (u.auth_subject LIKE 'load-${runId}-b%' OR u.auth_subject LIKE 'load-${runId}-d%')`;
	return {
		// 初期判定: 有効化のイベント行の作成時刻(起点)→そのIntentを含むLATCHの、
		// そのIntentの利用者への提案の通知の最小のpush_attempted_at(提案が無ければnull)
		judge: [
			"SELECT i.id AS intent_id,",
			"(SELECT min(me.created_at) FROM match_events me WHERE me.source_intent_id = i.id AND me.event_type = 'intent_created') AS activated_at,",
			"(SELECT min(n.push_attempted_at) FROM latches l JOIN json_each(l.intent_ids) j JOIN notifications n ON n.latch_id = l.id",
			"WHERE j.value = i.id AND n.user_id = i.user_id AND n.type = 'proposal') AS push_attempted_at",
			`FROM intents i JOIN users u ON u.id = i.user_id WHERE ${subject}`,
		].join(" "),
		// 通知: 提案の通知行の作成→Push送信試行
		notify: [
			"SELECT n.id AS notification_id, n.created_at AS created_at, n.push_attempted_at AS push_attempted_at",
			"FROM notifications n JOIN users u ON u.id = n.user_id",
			`WHERE n.type = 'proposal' AND ${subject}`,
		].join(" "),
		// Vectorizeの反映: vector_reflectionの行(意思のversionごとに1行)のstatusとpayloadのreflect_ms
		reflection: [
			"SELECT me.status AS status, json_extract(me.payload, '$.reflect_ms') AS reflect_ms",
			"FROM match_events me JOIN intents i ON i.id = me.source_intent_id JOIN users u ON u.id = i.user_id",
			`WHERE me.event_type = 'vector_reflection' AND ${subject}`,
		].join(" "),
		// Candidate Retrieval: embedding_completedのpayloadのretrieval_ms(最新のversion)。
		// イベント行の無いIntent(埋め込みを毎分Cronのバックフィルで行った場合など)はhas_event=0
		retrieval: [
			"SELECT i.id AS intent_id,",
			"EXISTS (SELECT 1 FROM match_events me WHERE me.source_intent_id = i.id AND me.event_type = 'embedding_completed') AS has_event,",
			"(SELECT json_extract(me.payload, '$.retrieval_ms') FROM match_events me WHERE me.source_intent_id = i.id AND me.event_type = 'embedding_completed'",
			"ORDER BY me.version DESC LIMIT 1) AS retrieval_ms",
			`FROM intents i JOIN users u ON u.id = i.user_id WHERE ${subject}`,
		].join(" "),
	};
}

/**
 * 初期判定の行→所要時間。提案が無い・起点のイベント行が無いIntentはnull(欠け)
 * @param {Array<{ activated_at: unknown, push_attempted_at: unknown }>} rows
 * @returns {Array<number | null>}
 */
export function judgeFromRows(rows) {
	return rows.map((r) => {
		const from = num(r.activated_at);
		const to = num(r.push_attempted_at);
		return from === null || to === null ? null : to - from;
	});
}

/**
 * 通知の行→所要時間。未送信はnull(欠け)
 * @param {Array<{ created_at: unknown, push_attempted_at: unknown }>} rows
 * @returns {Array<number | null>}
 */
export function notifyFromRows(rows) {
	return rows.map((r) => {
		const from = num(r.created_at);
		const to = num(r.push_attempted_at);
		return from === null || to === null ? null : to - from;
	});
}

/**
 * Candidate Retrievalの行→所要時間と、embedding_completedのイベント行が無いIntentの数
 * @param {Array<{ has_event: unknown, retrieval_ms: unknown }>} rows
 * @returns {{ durations: Array<number | null>, withoutEvent: number }}
 */
export function retrievalFromRows(rows) {
	return {
		durations: rows.map((r) => num(r.retrieval_ms)),
		withoutEvent: rows.filter((r) => !r.has_event).length,
	};
}

/**
 * Vectorizeの反映の行→所要時間。processedで値のあるものだけ値、failed・skipped(値なし)はnull(欠け)
 * @param {Array<{ status: unknown, reflect_ms: unknown }>} rows
 * @returns {Array<number | null>}
 */
export function reflectionFromRows(rows) {
	return rows.map((r) => (r.status === "processed" ? num(r.reflect_ms) : null));
}
