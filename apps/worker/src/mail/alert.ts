/**
 * オーナーへのメール(docs/04 §9 D-A-04の解消記録・LAT-124)。Jev予算の80%到達のアラートと、
 * 前日分の日次サマリを、毎分Cron(pipeline/cron.ts)から送る。
 *
 * 二重送信の防止: 送る前にD1のusage_counters(scope=alert_mail・key=メールの種類・
 * period=JST日付か月)へ「送る権利」の行を1件だけ入れ、入れられた実行だけが送る
 * (KVは書き込みの反映が遅れるため、重なったCronの実行が両方送らないようD1で決める)。
 * count=正なら送信中か送信済み(その回の試行番号)、負なら失敗した回数。失敗したら符号を
 * 反転して権利を手放し、次の分の実行がやり直す。ALERT_MAIL_MAX_ATTEMPTS回失敗したら諦める。
 * 送信中に実行が落ちた行は正のまま残り、送り直さない(同じメールを2通送るより、1通欠ける方を選ぶ)。
 * 行は他のusage_countersと同じく90日で消える(docs/05 §2.6)。
 *
 * 本文は件数・割合だけで、ID・本文・表示名は入れない(docs/08 §6)。
 */

import { LATCH, LIMITS } from "@latch/shared";
import { rate } from "../analytics/report";
import { type Clock, jstDayKey, jstHour } from "../clock/clock";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";
import type { AlertMail, MailSender } from "./sender";

const logger = createLogger();

/** 1通あたりの送信の試行の上限(毎分Cronで1回ずつ) */
export const ALERT_MAIL_MAX_ATTEMPTS = 3;

/** 日次サマリを送り始める時(日本時間・2026-10-27オーナー決定・04 §9) */
export const DAILY_SUMMARY_HOUR_JST = 9;

export type AlertMailKind =
	| "jev_global_daily"
	| "jev_global_monthly"
	| "daily_summary";

/** 処理待ちの滞留とみなす経過(15分・docs/runbooks/launch-day.md 6.2の(4)) */
const STUCK_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 送る権利を取る。取れたらその回の試行番号、取れなければnull */
const claim = async (
	db: D1Database,
	kind: AlertMailKind,
	period: string,
): Promise<number | null> => {
	const row = await db
		.prepare(
			"INSERT INTO usage_counters (scope, key, period, count) VALUES ('alert_mail', ?, ?, 1) " +
				"ON CONFLICT(scope, key, period) DO UPDATE SET count = 1 - count " +
				"WHERE count < 0 AND count > ? RETURNING count",
		)
		.bind(kind, period, -ALERT_MAIL_MAX_ATTEMPTS)
		.first<{ count: number }>();
	return row?.count ?? null;
};

/** 送れなかった権利を手放す(count=-失敗した回数) */
const release = async (
	db: D1Database,
	kind: AlertMailKind,
	period: string,
): Promise<void> => {
	await db
		.prepare(
			"UPDATE usage_counters SET count = -count WHERE scope = 'alert_mail' AND key = ? AND period = ? AND count > 0",
		)
		.bind(kind, period)
		.run();
};

/**
 * 種類と期間ごとに1通だけ送る。本文は権利を取れたときだけ作る(日次サマリの集計を毎分しない)。
 * 本文の作成か送信に失敗したら権利を手放し、warnログ(alert.mail.failed)を出す。
 * 権利を取る・手放すD1の失敗は呼び出し側(runIsolated)へ投げる
 */
export const sendAlertMailOnce = async (
	db: D1Database,
	sender: MailSender,
	kind: AlertMailKind,
	period: string,
	build: () => Promise<AlertMail>,
): Promise<"sent" | "skipped" | "failed"> => {
	const attempt = await claim(db, kind, period);
	if (attempt === null) return "skipped";
	let errorCode: string;
	try {
		const result = await sender.send(await build());
		if (result.kind === "ok") {
			logger.info("alert.mail.sent", { layer: kind, count: attempt });
			return "sent";
		}
		errorCode = result.errorCode;
	} catch {
		errorCode = "MAIL_BUILD_FAILED";
	}
	await release(db, kind, period);
	logger.warn("alert.mail.failed", {
		layer: kind,
		error_code: errorCode,
		count: attempt,
	});
	if (attempt >= ALERT_MAIL_MAX_ATTEMPTS) {
		logger.error("alert.mail.abandoned", { layer: kind, count: attempt });
	}
	return "failed";
};

const n = (v: number): string => v.toLocaleString("en-US");

const percent = (count: number, limit: number): string =>
	`${((count / limit) * 100).toFixed(1)}%`;

const subjectOf = (env: Env, title: string): string =>
	`[LATCH ${env.LATCH_ENV}] ${title}`;

/** Jev予算の80%到達のメール(docs/06 §6・09 §6の警報線) */
export const budgetAlertMail = (
	env: Env,
	target: {
		scope: "jev_global_daily" | "jev_global_monthly";
		period: string;
		limit: number;
	},
	count: number,
): AlertMail => {
	const range = target.scope === "jev_global_daily" ? "1日" : "1か月";
	return {
		subject: subjectOf(
			env,
			`Jevの予算の${LATCH.BUDGET_ALERT_RATIO * 100}%に達しました(${range}・${target.period})`,
		),
		text: [
			`Jev(AIの判定)の呼び出しが、上限の${LATCH.BUDGET_ALERT_RATIO * 100}%に達しました。`,
			"",
			`- 範囲: 全体の${range}(${target.period}・日本時間)`,
			`- 回数: ${n(count)}回 / 上限${n(target.limit)}回(${percent(count, target.limit)})`,
			"",
			"上限に達すると、それ以降の評価は保留へ縮退します(docs/06 §6)。",
			"初動は消費源の確認です(docs/06 §6・点検の手順はdocs/runbooks/launch-day.md 6章)。",
			"このメールは範囲と期間ごとに1回だけ送ります。",
		].join("\n"),
	};
};

/** 日本時間の日付の0時のミリ秒 */
const jstDayStartMs = (day: string): number =>
	Date.parse(`${day}T00:00:00+09:00`);

type FormCounts = { connection: number; occasion: number };

const byForm = (
	rows: Record<string, unknown>[],
	column: string,
): FormCounts => {
	const out: FormCounts = { connection: 0, occasion: 0 };
	for (const row of rows) {
		if (row.form === "connection" || row.form === "occasion") {
			out[row.form] += Number(row[column] ?? 0);
		}
	}
	return out;
};

const formLine = (c: FormCounts): string =>
	`つながりIntent ${n(c.connection)}件・機会Intent ${n(c.occasion)}件(合計${n(c.connection + c.occasion)}件)`;

/**
 * 前日(dayは日本時間の日付)の日次サマリ(2026-10-27オーナー決定・04 §9)。
 * コスト・異常の兆し・主な指標(09 §2)の3つを件数だけで出す。D1への読み取りは1往復(batch)
 */
export const buildDailySummary = async (
	env: Env,
	day: string,
	nowMs: number,
): Promise<AlertMail> => {
	const from = jstDayStartMs(day);
	const to = from + DAY_MS;
	const month = day.slice(0, 7);
	const db = env.DB;
	const [
		jevDaily,
		jevMonthly,
		externalSend,
		dead,
		stuck,
		reportCounts,
		newIntents,
		proposals,
	] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				"SELECT count FROM usage_counters WHERE scope = 'jev_global_daily' AND key = '-' AND period = ?",
			)
			.bind(day),
		db
			.prepare(
				"SELECT count FROM usage_counters WHERE scope = 'jev_global_monthly' AND key = '-' AND period = ?",
			)
			.bind(month),
		db
			.prepare(
				"SELECT key, count FROM usage_counters WHERE scope = 'external_send' AND period = ? ORDER BY key",
			)
			.bind(day),
		db.prepare("SELECT COUNT(*) AS n FROM match_events WHERE status = 'dead'"),
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM match_events WHERE status IN ('pending', 'failed') AND created_at < ?",
			)
			.bind(nowMs - STUCK_MS),
		db
			.prepare(
				"SELECT COUNT(CASE WHEN status = 'open' THEN 1 END) AS open, " +
					"COUNT(CASE WHEN created_at >= ? AND created_at < ? THEN 1 END) AS created FROM reports",
			)
			.bind(from, to),
		db
			.prepare(
				"SELECT form, COUNT(*) AS n FROM intents WHERE created_at >= ? AND created_at < ? AND status != 'draft' GROUP BY form",
			)
			.bind(from, to),
		// Mutual Latch Rate(09 §2): 分母=提示した提案・分子=成立した提案(成立の後のcancelledも成立)
		db
			.prepare(
				"SELECT l.form AS form, COUNT(*) AS proposed, " +
					"SUM(CASE WHEN EXISTS (SELECT 1 FROM latch_status_events e WHERE e.latch_id = l.id AND e.to_status = 'matched') THEN 1 ELSE 0 END) AS matched, " +
					"SUM(CASE WHEN l.status IN ('proposed', 'partial_accept') THEN 1 ELSE 0 END) AS open " +
					"FROM latches l WHERE l.proposed_at IS NOT NULL AND l.proposed_at >= ? AND l.proposed_at < ? GROUP BY l.form",
			)
			.bind(from, to),
	]);
	const first = (
		r: D1Result<Record<string, unknown>> | undefined,
		col: string,
	) => Number(r?.results[0]?.[col] ?? 0);
	const jevDay = first(jevDaily, "count");
	const jevMonth = first(jevMonthly, "count");
	const sends = (externalSend?.results ?? []).map(
		(r) => `  - ${String(r.key)}: ${n(Number(r.count ?? 0))}回`,
	);
	const intentsByForm = byForm(newIntents?.results ?? [], "n");
	const proposed = byForm(proposals?.results ?? [], "proposed");
	const matched = byForm(proposals?.results ?? [], "matched");
	const open = byForm(proposals?.results ?? [], "open");
	const total = (c: FormCounts) => c.connection + c.occasion;
	return {
		subject: subjectOf(env, `日次サマリ(${day})`),
		text: [
			`LATCH 日次サマリ(${day}・日本時間)`,
			"",
			"■ コスト",
			`- Jev(前日): ${n(jevDay)}回(1日の上限${n(LIMITS.JEV_GLOBAL_DAILY)}回の${percent(jevDay, LIMITS.JEV_GLOBAL_DAILY)})`,
			`- Jev(${month}の累計): ${n(jevMonth)}回(1か月の上限${n(LIMITS.JEV_GLOBAL_MONTHLY)}回の${percent(jevMonth, LIMITS.JEV_GLOBAL_MONTHLY)})`,
			"- LLMの事業者への送信(前日・宛先:用途ごと):",
			...(sends.length > 0 ? sends : ["  - なし"]),
			"",
			"■ 異常の兆し(このメールを作った時点)",
			`- 処理を諦めたイベント(dead): ${n(first(dead, "n"))}件(0が正常)`,
			`- 15分より前から処理待ちのイベント: ${n(first(stuck, "n"))}件(0が正常)`,
			`- 未対応(open)の通報: ${n(first(reportCounts, "open"))}件 / 前日の新しい通報: ${n(first(reportCounts, "created"))}件`,
			"",
			"■ 主な指標(前日)",
			`- 新しいIntent(下書きを除く): ${formLine(intentsByForm)}`,
			`- 提示した提案: ${formLine(proposed)}`,
			`- 成立した提案: ${formLine(matched)}`,
			`- Mutual Latch Rate: つながりIntent ${rate(matched.connection, proposed.connection)}・機会Intent ${rate(matched.occasion, proposed.occasion)}・合計 ${rate(total(matched), total(proposed))}`,
			...(total(open) > 0
				? [
						`  (回答期間中の提案が${n(total(open))}件あり、確定するまで低く出ます)`,
					]
				: []),
			"",
			"件数だけを載せています。詳しい集計は pnpm analytics:report(docs/09 §2)。",
		].join("\n"),
	};
};

/**
 * 日次サマリの送信(毎分Cron)。日本時間のDAILY_SUMMARY_HOUR_JST時以降の最初の実行で、
 * 前日分を1通送る(その日の残りの実行は権利を取れずに何もしない)
 */
export const runDailySummary = async (
	env: Env,
	sender: MailSender,
	clock: Clock,
): Promise<void> => {
	const now = clock.now();
	if (jstHour(now) < DAILY_SUMMARY_HOUR_JST) return;
	const day = jstDayKey(new Date(now.getTime() - DAY_MS));
	await sendAlertMailOnce(env.DB, sender, "daily_summary", day, () =>
		buildDailySummary(env, day, now.getTime()),
	);
};
