/**
 * Analytics諸量の集計(02 §4 #35・docs/09 §2)。D1への読み取りの問い合わせ(SELECTのみ)と、
 * その結果の行からMarkdownの表を組み立てる部分(純粋関数)。D1の部品は読み込まない
 * (集計のコマンド`scripts/analytics-report.mjs`がNodeから直接読み込むため)。
 * 出すのは件数・割合・分布だけで、ID・本文・表示名は問い合わせの結果にも含めない(08 §6)。
 * 時刻の列はD1の整数のミリ秒(drizzleのtimestamp_ms)。期間は日本時間の日付で区切る。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_S = 9 * 60 * 60;
/** チャット開始の判定の窓(成立から7日・docs/09 §2) */
const CHAT_START_WINDOW_MS = 7 * DAY_MS;

export type AnalyticsForm = "connection" | "occasion";
const FORMS: AnalyticsForm[] = ["connection", "occasion"];
const FORM_LABEL: Record<AnalyticsForm, string> = {
	connection: "つながりIntent",
	occasion: "機会Intent",
};

/** 集計の期間。from・toは日本時間の日付(両端を含む) */
export interface AnalyticsRange {
	from: string;
	to: string;
	/** 集計の時刻(チャット開始の判定ができるかの境目) */
	nowMs: number;
}

type Row = Record<string, unknown>;

export type AnalyticsQueryName =
	| "evaluations"
	| "jevDaily"
	| "jevPerIntent"
	| "candidateScores"
	| "latchScores"
	| "responses"
	| "mutual"
	| "chatStart";

export type AnalyticsRows = Record<AnalyticsQueryName, Row[]>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日本時間の日付の0時のミリ秒。日付として正しくなければ例外 */
const jstDayStartMs = (day: string): number => {
	const ms = DATE_RE.test(day) ? Date.parse(`${day}T00:00:00+09:00`) : NaN;
	if (
		!Number.isFinite(ms) ||
		new Date(ms + JST_OFFSET_S * 1000).toISOString().slice(0, 10) !== day
	) {
		throw new Error(`日付はYYYY-MM-DDで指定してください: ${day}`);
	}
	return ms;
};

/** 日本時間の日付(YYYY-MM-DD) */
export const jstDay = (ms: number): string =>
	new Date(ms + JST_OFFSET_S * 1000).toISOString().slice(0, 10);

/**
 * 集計のSQLを返す。期間の日付と時刻は検査した値だけを差し込む(wranglerの`--command`は
 * 束縛の引数を持たないため)。期間はfromの0時以上・toの翌日0時未満
 */
export const buildAnalyticsQueries = (
	range: AnalyticsRange,
): Record<AnalyticsQueryName, string> => {
	const fromMs = jstDayStartMs(range.from);
	const toMs = jstDayStartMs(range.to) + DAY_MS;
	if (fromMs >= toMs) {
		throw new Error("期間の始まりは終わり以前の日付にしてください");
	}
	if (!Number.isSafeInteger(range.nowMs)) {
		throw new Error("集計の時刻が不正です");
	}
	const inRange = (col: string) => `${col} >= ${fromMs} AND ${col} < ${toMs}`;
	const periodInRange = `period >= '${range.from}' AND period <= '${range.to}'`;
	const p = (key: string) => `json_extract(me.payload, '$.${key}')`;
	const sum = (key: string) => `COALESCE(SUM(${p(key)}), 0) AS ${key}`;
	return {
		// 第2段の評価1回ごとの層通過件数とJev(docs/06 §7)。payloadに層通過件数を持つ行だけが
		// 評価した行(抑制・対象外・反映を確かめただけの行はretrieval_countを持たない)。
		// 毎分Cronが評価本体を直接呼ぶ評価と、削除した意思の行はD1に無い(docs/09 §2)
		evaluations: [
			"SELECT i.form AS form, COUNT(*) AS evaluations,",
			[
				"retrieval_count",
				"l1_pass",
				"l3_pass",
				"l5_over_threshold",
				"proposed",
				"held_proposals",
				"group_proposed",
				"jev_calls",
				"group_jev_calls",
				"jev_reused",
			]
				.map(sum)
				.join(", "),
			"FROM match_events me JOIN intents i ON i.id = me.source_intent_id",
			"WHERE me.event_type IN ('embedding_completed', 'vector_reflection') AND me.status = 'processed'",
			`AND ${p("retrieval_count")} IS NOT NULL AND ${inRange("me.processed_at")}`,
			"GROUP BY i.form",
		].join(" "),
		// Jevの全体の日次の計上(usage_counters・毎分Cronの評価も含む・docs/06 §6)
		jevDaily: `SELECT period AS day, count FROM usage_counters WHERE scope = 'jev_global_daily' AND key = '-' AND ${periodInRange} ORDER BY period`,
		// 1Intentあたりの計上(起点側の意思ごとの日次の計上・docs/06 §6)
		jevPerIntent: `SELECT COUNT(DISTINCT key) AS intents, COALESCE(SUM(count), 0) AS calls FROM usage_counters WHERE scope = 'jev_intent' AND ${periodInRange}`,
		// 評価した組のLATCH Score(match_candidates・30日で削除・docs/05 §2.6)
		candidateScores: [
			"SELECT form, MIN(CAST(latch_score * 10 AS INTEGER), 9) AS bucket, COUNT(*) AS n,",
			"AVG(latch_score) AS avg, MIN(latch_score) AS min, MAX(latch_score) AS max",
			`FROM match_candidates WHERE latch_score IS NOT NULL AND ${inRange("updated_at")}`,
			"GROUP BY form, bucket",
		].join(" "),
		// 提案化した組のLATCH Score(latches.score・保留を含む。グループは全ペアの最小値)
		latchScores: [
			"SELECT form, MIN(CAST(score * 10 AS INTEGER), 9) AS bucket, COUNT(*) AS n,",
			"AVG(score) AS avg, MIN(score) AS min, MAX(score) AS max",
			`FROM latches WHERE ${inRange("created_at")}`,
			"GROUP BY form, bucket",
		].join(" "),
		// 提示した提案の参加者ごとの回答(回答の無い参加者は無回答)
		responses: [
			"SELECT l.form AS form, COUNT(*) AS seats,",
			"SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,",
			"SUM(CASE WHEN r.response = 'yes' AND r.retracted_at IS NOT NULL THEN 1 ELSE 0 END) AS yes_retracted,",
			"SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no,",
			"SUM(CASE WHEN r.response = 'defer' THEN 1 ELSE 0 END) AS defer,",
			"SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END) AS unanswered",
			"FROM latches l JOIN latch_members m ON m.latch_id = l.id",
			"LEFT JOIN latch_responses r ON r.latch_id = l.id AND r.user_id = m.user_id",
			`WHERE l.proposed_at IS NOT NULL AND ${inRange("l.proposed_at")}`,
			"GROUP BY l.form",
		].join(" "),
		// Mutual Latch Rate(docs/09 §2): 分母=提示した提案(1提案1計上)・分子=成立した提案。
		// 提示した日(日本時間)ごとに分け、まだ回答期間中の提案を別に数える
		mutual: [
			`SELECT l.form AS form, date(l.proposed_at / 1000 + ${JST_OFFSET_S}, 'unixepoch') AS day, COUNT(*) AS proposed,`,
			"SUM(CASE WHEN EXISTS (SELECT 1 FROM latch_status_events e WHERE e.latch_id = l.id AND e.to_status = 'matched') THEN 1 ELSE 0 END) AS matched,",
			"SUM(CASE WHEN l.status IN ('proposed', 'partial_accept') THEN 1 ELSE 0 END) AS open",
			`FROM latches l WHERE l.proposed_at IS NOT NULL AND ${inRange("l.proposed_at")}`,
			"GROUP BY l.form, day ORDER BY day, l.form",
		].join(" "),
		// チャット開始率(docs/09 §2): 成立から7日以内に参加者全員が1件以上送信した成立の割合。
		// 成立から7日たっていない成立は判定待ちとして分母に入れない
		chatStart: [
			"SELECT l.form AS form, COUNT(*) AS matched,",
			`SUM(CASE WHEN e.matched_at + ${CHAT_START_WINDOW_MS} <= ${range.nowMs} THEN 1 ELSE 0 END) AS judged,`,
			`SUM(CASE WHEN e.matched_at + ${CHAT_START_WINDOW_MS} <= ${range.nowMs} AND NOT EXISTS (`,
			"SELECT 1 FROM latch_members m WHERE m.latch_id = l.id AND NOT EXISTS (",
			"SELECT 1 FROM messages g WHERE g.latch_id = l.id AND g.user_id = m.user_id",
			`AND g.created_at <= e.matched_at + ${CHAT_START_WINDOW_MS})) THEN 1 ELSE 0 END) AS started`,
			"FROM latches l JOIN (SELECT latch_id, MIN(created_at) AS matched_at FROM latch_status_events",
			"WHERE to_status = 'matched' GROUP BY latch_id) e ON e.latch_id = l.id",
			`WHERE ${inRange("e.matched_at")}`,
			"GROUP BY l.form",
		].join(" "),
	};
};

const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

const isForm = (v: unknown): v is AnalyticsForm =>
	v === "connection" || v === "occasion";

/** 形式ごとの値(合計は形式の和) */
export type ByForm<T> = Record<AnalyticsForm | "total", T>;

const byForm = <T>(make: () => T): ByForm<T> => ({
	connection: make(),
	occasion: make(),
	total: make(),
});

/** 行を形式ごとに足し合わせる(keysの列の和・合計も作る) */
const sumByForm = <K extends string>(
	rows: Row[],
	keys: readonly K[],
): ByForm<Record<K, number>> => {
	const zero = () =>
		Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
	const out = byForm(zero);
	for (const row of rows) {
		if (!isForm(row.form)) continue;
		for (const k of keys) {
			out[row.form][k] += num(row[k]);
			out.total[k] += num(row[k]);
		}
	}
	return out;
};

const EVALUATION_KEYS = [
	"evaluations",
	"retrieval_count",
	"l1_pass",
	"l3_pass",
	"l5_over_threshold",
	"proposed",
	"held_proposals",
	"group_proposed",
	"jev_calls",
	"group_jev_calls",
	"jev_reused",
] as const;
const RESPONSE_KEYS = [
	"seats",
	"yes",
	"yes_retracted",
	"no",
	"defer",
	"unanswered",
] as const;
const MUTUAL_KEYS = ["proposed", "matched", "open"] as const;
const CHAT_KEYS = ["matched", "judged", "started"] as const;

export interface ScoreSummary {
	n: number;
	avg: number | null;
	min: number | null;
	max: number | null;
	/** 0.1刻みの件数(添字0=0.0以上0.1未満 … 9=0.9以上1.0以下) */
	buckets: number[];
}

/** 0.1刻みの行から形式ごとの分布をまとめる(平均は件数の重みで合成する) */
const scoreByForm = (rows: Row[]): ByForm<ScoreSummary> => {
	const out = byForm<ScoreSummary>(() => ({
		n: 0,
		avg: null,
		min: null,
		max: null,
		buckets: Array(10).fill(0),
	}));
	const weighted = byForm(() => 0);
	for (const row of rows) {
		if (!isForm(row.form)) continue;
		const n = num(row.n);
		const bucket = Math.min(9, Math.max(0, num(row.bucket)));
		for (const s of [row.form, "total"] as const) {
			const t = out[s];
			t.n += n;
			t.buckets[bucket] += n;
			weighted[s] += num(row.avg) * n;
			t.min = t.min === null ? num(row.min) : Math.min(t.min, num(row.min));
			t.max = t.max === null ? num(row.max) : Math.max(t.max, num(row.max));
		}
	}
	for (const s of [...FORMS, "total"] as const) {
		out[s].avg = out[s].n > 0 ? weighted[s] / out[s].n : null;
	}
	return out;
};

export interface AnalyticsSummary {
	evaluations: ByForm<Record<(typeof EVALUATION_KEYS)[number], number>>;
	jev: {
		daily: { day: string; count: number }[];
		total: number;
		intents: number;
		perIntentCalls: number;
	};
	candidateScores: ByForm<ScoreSummary>;
	latchScores: ByForm<ScoreSummary>;
	responses: ByForm<Record<(typeof RESPONSE_KEYS)[number], number>>;
	mutual: ByForm<Record<(typeof MUTUAL_KEYS)[number], number>>;
	mutualDaily: {
		day: string;
		form: AnalyticsForm;
		proposed: number;
		matched: number;
		open: number;
	}[];
	chatStart: ByForm<Record<(typeof CHAT_KEYS)[number], number>>;
}

/** 問い合わせの結果の行を集計の値にまとめる */
export const summarizeAnalytics = (rows: AnalyticsRows): AnalyticsSummary => {
	const daily = rows.jevDaily.map((r) => ({
		day: String(r.day),
		count: num(r.count),
	}));
	const perIntent = rows.jevPerIntent[0] ?? {};
	return {
		evaluations: sumByForm(rows.evaluations, EVALUATION_KEYS),
		jev: {
			daily,
			total: daily.reduce((a, d) => a + d.count, 0),
			intents: num(perIntent.intents),
			perIntentCalls: num(perIntent.calls),
		},
		candidateScores: scoreByForm(rows.candidateScores),
		latchScores: scoreByForm(rows.latchScores),
		responses: sumByForm(rows.responses, RESPONSE_KEYS),
		mutual: sumByForm(rows.mutual, MUTUAL_KEYS),
		mutualDaily: rows.mutual
			.filter((r) => isForm(r.form))
			.map((r) => ({
				day: String(r.day),
				form: r.form as AnalyticsForm,
				proposed: num(r.proposed),
				matched: num(r.matched),
				open: num(r.open),
			})),
		chatStart: sumByForm(rows.chatStart, CHAT_KEYS),
	};
};

/** 割合(分母0は—) */
export const rate = (numerator: number, denominator: number): string =>
	denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—";

const fixed = (v: number | null, digits = 3): string =>
	v === null ? "—" : v.toFixed(digits);

const avgPer = (total: number, count: number): string =>
	count > 0 ? (total / count).toFixed(2) : "—";

const table = (head: string[], body: string[][]): string =>
	[
		`| ${head.join(" | ")} |`,
		`|${head.map(() => "---").join("|")}|`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	].join("\n");

const COLUMNS = [...FORMS, "total"] as const;
const COLUMN_HEAD = [...FORMS.map((f) => FORM_LABEL[f]), "合計"];

/** 形式ごとの列を持つ表(1行=1指標) */
const formTable = (
	rowsSpec: [string, (s: (typeof COLUMNS)[number]) => string][],
): string =>
	table(
		["指標", ...COLUMN_HEAD],
		rowsSpec.map(([label, cell]) => [label, ...COLUMNS.map(cell)]),
	);

const scoreTable = (s: ByForm<ScoreSummary>): string =>
	formTable([
		["件数", (c) => String(s[c].n)],
		["平均", (c) => fixed(s[c].avg)],
		["最小", (c) => fixed(s[c].min)],
		["最大", (c) => fixed(s[c].max)],
		...Array.from(
			{ length: 10 },
			(_, i): [string, (c: (typeof COLUMNS)[number]) => string] => [
				`${(i / 10).toFixed(1)}〜${i === 9 ? "1.0" : `${((i + 1) / 10).toFixed(1)}未満`}`,
				(c) => String(s[c].buckets[i]),
			],
		),
	]);

/** 集計の値をMarkdownにする(純粋関数) */
export const renderAnalyticsReport = (
	range: AnalyticsRange,
	s: AnalyticsSummary,
): string => {
	const e = s.evaluations;
	const r = s.responses;
	const m = s.mutual;
	const c = s.chatStart;
	return [
		`## Analytics諸量の集計(${range.from}〜${range.to}・日本時間)`,
		"",
		`- 集計の時刻: ${new Date(range.nowMs).toISOString()}。定義は docs/09 §2。件数・割合・分布だけを出し、IDと本文は出さない`,
		"",
		"### 候補数(第2段の評価ごとの層通過件数)",
		"",
		formTable([
			["評価の回数", (k) => String(e[k].evaluations)],
			[
				"Layer 2 Candidate Retrievalの取得",
				(k) => String(e[k].retrieval_count),
			],
			["Layer 1の通過", (k) => String(e[k].l1_pass)],
			["候補数(Layer 3の通過)", (k) => String(e[k].l3_pass)],
			["1評価あたりの候補数", (k) => avgPer(e[k].l3_pass, e[k].evaluations)],
			["Layer 5の閾値超え", (k) => String(e[k].l5_over_threshold)],
			["提示(1対1)", (k) => String(e[k].proposed)],
			["保留(通知上限)", (k) => String(e[k].held_proposals)],
			["提示(グループ)", (k) => String(e[k].group_proposed)],
		]),
		"",
		"- 意思の作成・更新の直後の評価(embedding_completed)と反映確認の評価し直し(vector_reflection)の行を数える。毎分Cronが評価本体を直接呼ぶ評価と、削除した意思の評価は含まない(全量はAnalytics Engine・docs/09 §2)。形式は起点の意思の形式",
		"",
		"### Jev実行回数",
		"",
		formTable([
			["評価の記録の呼び出し(1対1)", (k) => String(e[k].jev_calls)],
			["評価の記録の呼び出し(グループ)", (k) => String(e[k].group_jev_calls)],
			["既存の判定の再利用", (k) => String(e[k].jev_reused)],
		]),
		"",
		table(
			["日付", "全体の計上"],
			[
				...s.jev.daily.map((d) => [d.day, String(d.count)]),
				["合計", String(s.jev.total)],
			],
		),
		"",
		`- 1Intentあたりの計上: ${avgPer(s.jev.perIntentCalls, s.jev.intents)}回(Jevを呼んだ意思 ${s.jev.intents}件・計上 ${s.jev.perIntentCalls}回)`,
		"- 全体の計上と1Intentあたりは予算の計上(usage_counters・毎分Cronの評価を含む・90日で削除)。上限で止めた1回も数える(docs/06 §6)",
		"",
		"### LATCH Score(評価した組)",
		"",
		scoreTable(s.candidateScores),
		"",
		"- match_candidatesの行(評価した期間で数える・30日で削除・docs/05 §2.6)",
		"",
		"### LATCH Score(提案化した組)",
		"",
		scoreTable(s.latchScores),
		"",
		"- latchesの行(作成した期間で数える・通知上限で保留した提案を含む。グループは全ペアの最小値)",
		"",
		"### YES/NO(提示した提案の参加者ごとの回答)",
		"",
		formTable([
			["参加者(延べ)", (k) => String(r[k].seats)],
			["yes", (k) => String(r[k].yes)],
			["うち取り消し・無効化", (k) => String(r[k].yes_retracted)],
			["no", (k) => String(r[k].no)],
			["defer(見送り)", (k) => String(r[k].defer)],
			["無回答", (k) => String(r[k].unanswered)],
			["YES率", (k) => rate(r[k].yes, r[k].seats)],
			["無回答率", (k) => rate(r[k].unanswered, r[k].seats)],
		]),
		"",
		"- 提示した期間で数える。回答期間中の提案の無回答も含む(下のMutual Latch Rateの回答期間中を参照)",
		"",
		"### Mutual Latch Rate",
		"",
		formTable([
			["提示した提案", (k) => String(m[k].proposed)],
			["成立", (k) => String(m[k].matched)],
			["回答期間中", (k) => String(m[k].open)],
			["Mutual Latch Rate", (k) => rate(m[k].matched, m[k].proposed)],
		]),
		"",
		table(
			["提示した日", "形式", "提示", "成立", "回答期間中", "Mutual Latch Rate"],
			s.mutualDaily.map((d) => [
				d.day,
				FORM_LABEL[d.form],
				String(d.proposed),
				String(d.matched),
				String(d.open),
				rate(d.matched, d.proposed),
			]),
		),
		"",
		"### チャット開始率",
		"",
		formTable([
			["成立", (k) => String(c[k].matched)],
			["判定できる成立(成立から7日経過)", (k) => String(c[k].judged)],
			["チャット開始", (k) => String(c[k].started)],
			["チャット開始率", (k) => rate(c[k].started, c[k].judged)],
		]),
		"",
		"- 成立した期間で数える。開始は成立から7日以内に参加者全員が1件以上送信したもの(グループも全員)",
	].join("\n");
};

/** 既定の期間(集計の日を含む直近30日) */
export const defaultRange = (nowMs: number): AnalyticsRange => ({
	from: jstDay(nowMs - 29 * DAY_MS),
	to: jstDay(nowMs),
	nowMs,
});
