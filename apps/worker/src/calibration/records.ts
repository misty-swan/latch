/**
 * 正解データ(calibration_records・docs/01 §14・docs/05 §2.2・§2.5・docs/08 §7)。
 * Human Intent → Prediction → Proposal → Actual YES/NO → Actual Action を1LATCH1行で残す。
 * - 作成: 提示した(proposed_atのある)提案が閉じた後(matched・completed・rejected・expired・
 *   cancelled)に、毎分Cronが行を作る。予測(latch_score・Jevの7軸)はmatch_candidates
 *   (30日で削除)から写すため、閉じた直後に作る。作成済みの印はlatches.calibrated_atに置く
 *   (匿名化した行はlatch_idを持たないため)。未提示のまま閉じた提案は行を作らず印だけを付ける
 * - 確定と匿名化(2026-10-26オーナー決定・LAT-108): 行は観測の間だけLATCHに紐づける。
 *   観測の終わり(成立しなかった提案は閉じた時点・つながりは成立から30日・機会は対象時刻から
 *   30日)・参加者の退会・参加Intentの削除のいずれかで、その時点までの行動でactionを確定し、
 *   latch_idをnull化・時刻を日単位(母集団が小さい日は月単位)に丸めてanonymized=trueにする
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jstDayStart, jstHour, jstMonthStart } from "../clock/clock";
import {
	blocks,
	type CalibrationOutcome,
	calibrationRecords,
	intents,
	latches,
	latchFeedback,
	latchMembers,
	latchStatusEvents,
	matchCandidates,
	messages,
	reports,
	users,
} from "../db/schema";
import { newUlid } from "../ids";
import { MS_PER_DAY } from "../intents/expiry";
import { lookupMunicipality } from "../latches/region";
import type { JevAxes } from "../llm/types";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";

const logger = createLogger();

/** 成立後の観測期間(つながり=成立から・機会=対象時刻から・docs/05 §2.2) */
export const OBSERVATION_DAYS = 30;
/** 日単位で丸める母集団の下限(その日に提示した提案の数・下回れば月単位・docs/08 §7) */
export const MIN_DAILY_POPULATION = 10;
/** 1回の掃査で扱う件数(Cronの他の走査と同じ頭打ち・docs/04 §4) */
const SWEEP_LIMIT = 500;

/** 提案が閉じた状態(正解データの作成の対象) */
const CLOSED_STATUSES = [
	"matched",
	"completed",
	"rejected",
	"expired",
	"cancelled",
] as const;

type LatchRow = typeof latches.$inferSelect;

export interface CalibrationPrediction {
	latch_score: number;
	/** ペア(intent_a < intent_b)ごとのJevの7軸。評価の行が残っていないペアは含めない */
	jev: JevAxes[];
}

export interface CalibrationContext {
	participants: number;
	/** 機会の対象時刻の時間帯(JST)。つながりはnull */
	time_bin: "night" | "morning" | "afternoon" | "evening" | null;
	/** 基準Intentの地域の市区町村。地域なし・Intentが無いときはnull */
	municipality: string | null;
}

export type CalibrationAction =
	| { attended: boolean | null; attended_true: number; attended_false: number }
	| {
			chat_started_7d: boolean;
			exchanges_7d: number;
			exchanges_30d: number;
			blocked: boolean;
			reported: boolean;
	  };

export interface CalibrationSurvey {
	/** 1〜5の回答(昇順・誰の回答かは持たない) */
	scores: number[];
	/** [スキップ](null)の数 */
	skipped: number;
}

/** 状態の記録にmatchedがあれば最初の時刻(成立の後の離脱・ブロックでcancelledでも成立) */
const matchedAtOf = async (
	db: DrizzleD1Database,
	latchId: string,
): Promise<Date | null> => {
	const [row] = await db
		.select({ at: sql<number | null>`min(${latchStatusEvents.createdAt})` })
		.from(latchStatusEvents)
		.where(
			and(
				eq(latchStatusEvents.latchId, latchId),
				eq(latchStatusEvents.toStatus, "matched"),
			),
		);
	return row?.at == null ? null : new Date(row.at);
};

/** 結果。rejectedはno・deferのどちらで閉じたものも含む(docs/05 §2.2) */
export const outcomeOf = (
	status: LatchRow["status"],
	matched: boolean,
): CalibrationOutcome => {
	if (matched) return "both_yes";
	if (status === "rejected") return "one_no";
	if (status === "expired") return "expired";
	return "cancelled";
};

const timeWindowStartOf = (latch: LatchRow): Date | null => {
	const start = (latch.proposal as { time_window?: { start?: string } | null })
		.time_window?.start;
	return start === undefined ? null : new Date(start);
};

/** 観測の終わり。成立しなかった提案は閉じた時点(null=いま確定する) */
export const observationEndOf = (
	latch: LatchRow,
	matchedAt: Date | null,
): Date | null => {
	if (matchedAt === null) return null;
	const base =
		latch.form === "occasion"
			? (timeWindowStartOf(latch) ?? matchedAt)
			: matchedAt;
	return new Date(base.getTime() + OBSERVATION_DAYS * MS_PER_DAY);
};

/** JSTの時間帯のビン(6時間ずつ・docs/08 §7) */
export const timeBinOf = (at: Date): CalibrationContext["time_bin"] => {
	const hour = jstHour(at);
	if (hour < 6) return "night";
	if (hour < 12) return "morning";
	if (hour < 18) return "afternoon";
	return "evening";
};

/** ペアごとに提案を作った時点までの最新の評価のJevの7軸を写す(無ければその後の最初の評価) */
const predictionOf = async (
	db: DrizzleD1Database,
	latch: LatchRow,
): Promise<CalibrationPrediction> => {
	const ids = [...latch.intentIds].sort();
	const createdMs = latch.createdAt.getTime();
	const jev: JevAxes[] = [];
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const [row] = await db
				.select({ jevResult: matchCandidates.jevResult })
				.from(matchCandidates)
				.where(
					and(
						eq(matchCandidates.intentAId, ids[i]),
						eq(matchCandidates.intentBId, ids[j]),
						sql`${matchCandidates.jevResult} IS NOT NULL`,
					),
				)
				.orderBy(
					sql`CASE WHEN ${matchCandidates.updatedAt} <= ${createdMs} THEN 0 ELSE 1 END`,
					sql`CASE WHEN ${matchCandidates.updatedAt} <= ${createdMs} THEN -${matchCandidates.updatedAt} ELSE ${matchCandidates.updatedAt} END`,
				)
				.limit(1);
			if (row?.jevResult != null) jev.push(row.jevResult as JevAxes);
		}
	}
	return { latch_score: latch.score, jev };
};

/** 提案の条件の粗い形。地域は基準Intent(最も先に預けられた者・content.tsと同じ)の中心から引く */
const contextOf = async (
	db: DrizzleD1Database,
	latch: LatchRow,
): Promise<CalibrationContext> => {
	const rows = await db
		.select({
			id: intents.id,
			createdAt: intents.createdAt,
			lat: intents.geoCenterLat,
			lng: intents.geoCenterLng,
			radius: intents.geoRadiusM,
		})
		.from(intents)
		.where(inArray(intents.id, latch.intentIds));
	let base: (typeof rows)[number] | null = null;
	for (const r of rows) {
		const d =
			base === null ? -1 : r.createdAt.getTime() - base.createdAt.getTime();
		if (base === null || d < 0 || (d === 0 && r.id < base.id)) base = r;
	}
	const municipality =
		base !== null &&
		base.lat !== null &&
		base.lng !== null &&
		base.radius !== null
			? await lookupMunicipality(db, { lat: base.lat, lng: base.lng })
			: null;
	const start = latch.form === "occasion" ? timeWindowStartOf(latch) : null;
	return {
		participants: latch.intentIds.length,
		time_bin: start === null ? null : timeBinOf(start),
		municipality,
	};
};

/** 発言者が入れ替わった回数(最初の発言は数えない)。往復の数え方(docs/05 §2.2) */
export const exchangesOf = (senders: string[]): number => {
	let count = 0;
	for (let i = 1; i < senders.length; i += 1) {
		if (senders[i] !== senders[i - 1]) count += 1;
	}
	return count;
};

/** untilまでに観測できた行動(Actual Action)とつながりの1問 */
const observe = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	matchedAt: Date | null,
	until: Date,
): Promise<{ action: CalibrationAction; survey: CalibrationSurvey | null }> => {
	const untilMs = until.getTime();
	if (latch.form === "occasion") {
		const rows = await db
			.select({ value: latchFeedback.value })
			.from(latchFeedback)
			.where(
				and(
					eq(latchFeedback.latchId, latch.id),
					eq(latchFeedback.kind, "attendance"),
				),
			);
		let yes = 0;
		let no = 0;
		for (const r of rows) {
			const attended = (r.value as { attended?: boolean | null }).attended;
			if (attended === true) yes += 1;
			if (attended === false) no += 1;
		}
		return {
			action: {
				attended: yes > 0 ? true : no > 0 ? false : null,
				attended_true: yes,
				attended_false: no,
			},
			survey: null,
		};
	}

	const memberIds = (
		await db
			.select({ userId: latchMembers.userId })
			.from(latchMembers)
			.where(eq(latchMembers.latchId, latch.id))
	).map((r) => r.userId);
	let chatStarted = false;
	let exchanges7d = 0;
	let exchanges30d = 0;
	if (matchedAt !== null) {
		const matchedMs = matchedAt.getTime();
		const end30 = Math.min(matchedMs + OBSERVATION_DAYS * MS_PER_DAY, untilMs);
		const end7 = Math.min(matchedMs + 7 * MS_PER_DAY, untilMs);
		const rows = await db
			.select({ userId: messages.userId, createdAt: messages.createdAt })
			.from(messages)
			.where(
				and(
					eq(messages.latchId, latch.id),
					sql`${messages.createdAt} >= ${matchedMs}`,
					sql`${messages.createdAt} < ${end30}`,
				),
			)
			.orderBy(asc(messages.id));
		const within7 = rows.filter((r) => r.createdAt.getTime() < end7);
		// 成立時の参加者全員が7日以内に1件以上送信(離脱した参加者も数える・09 §2)
		const senders7 = new Set(within7.map((r) => r.userId));
		chatStarted =
			memberIds.length > 0 && memberIds.every((id) => senders7.has(id));
		exchanges7d = exchangesOf(within7.map((r) => r.userId));
		exchanges30d = exchangesOf(rows.map((r) => r.userId));
	}
	const windowEnd =
		matchedAt === null
			? untilMs
			: Math.min(matchedAt.getTime() + OBSERVATION_DAYS * MS_PER_DAY, untilMs);
	const [blocked] =
		memberIds.length < 2
			? [undefined]
			: await db
					.select({ n: sql<number>`count(*)` })
					.from(blocks)
					.where(
						and(
							inArray(blocks.blockerUserId, memberIds),
							inArray(blocks.blockedUserId, memberIds),
							sql`${blocks.createdAt} >= ${latch.createdAt.getTime()}`,
							sql`${blocks.createdAt} <= ${windowEnd}`,
						),
					);
	const [reported] = await db
		.select({ n: sql<number>`count(*)` })
		.from(reports)
		.where(
			and(
				eq(reports.latchId, latch.id),
				sql`${reports.createdAt} <= ${windowEnd}`,
			),
		);
	const quality = await db
		.select({ value: latchFeedback.value })
		.from(latchFeedback)
		.where(
			and(
				eq(latchFeedback.latchId, latch.id),
				eq(latchFeedback.kind, "connection_quality"),
			),
		);
	const scores: number[] = [];
	let skipped = 0;
	for (const r of quality) {
		const score = (r.value as { score?: number | null }).score;
		if (typeof score === "number") scores.push(score);
		else skipped += 1;
	}
	scores.sort((a, b) => a - b);
	return {
		action: {
			chat_started_7d: chatStarted,
			exchanges_7d: exchanges7d,
			exchanges_30d: exchanges30d,
			blocked: (blocked?.n ?? 0) > 0,
			reported: (reported?.n ?? 0) > 0,
		},
		survey: quality.length === 0 ? null : { scores, skipped },
	};
};

/** 参加者の退会・参加Intentの削除があれば、観測の途中でも確定して匿名化する */
const mustAnonymizeNow = async (
	db: DrizzleD1Database,
	latch: LatchRow,
): Promise<boolean> => {
	const [withdrawn] = await db
		.select({ n: sql<number>`count(*)` })
		.from(latchMembers)
		.innerJoin(users, eq(users.id, latchMembers.userId))
		.where(
			and(eq(latchMembers.latchId, latch.id), eq(users.status, "deleted")),
		);
	if ((withdrawn?.n ?? 0) > 0) return true;
	const [present] = await db
		.select({ n: sql<number>`count(*)` })
		.from(intents)
		.where(inArray(intents.id, latch.intentIds));
	return (present?.n ?? 0) < latch.intentIds.length;
};

/**
 * 匿名化の時刻。提示した時刻をJSTの日に丸め、その日に提示した提案が
 * MIN_DAILY_POPULATION件に満たなければ月に丸める(日単位では再識別の経路が残るため・docs/08 §7)
 */
export const anonymizedTimeOf = async (
	db: DrizzleD1Database,
	proposedAt: Date,
): Promise<Date> => {
	const dayStart = jstDayStart(proposedAt);
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(latches)
		.where(
			and(
				sql`${latches.proposedAt} >= ${dayStart.getTime()}`,
				sql`${latches.proposedAt} < ${dayStart.getTime() + MS_PER_DAY}`,
			),
		);
	return (row?.n ?? 0) >= MIN_DAILY_POPULATION
		? dayStart
		: jstMonthStart(proposedAt);
};

/**
 * 閉じた提案の行を作る。印(calibrated_at)が無いときだけ、行の挿入と印を1つの取引で書く
 * (再実行・並行した実行で二重に作らない)。作ったらtrue
 */
export const createRecord = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	now: Date,
): Promise<boolean> => {
	const nowMs = now.getTime();
	const unmarked = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latch.id} AND calibrated_at IS NULL)`;
	const mark = db
		.update(latches)
		.set({ calibratedAt: now })
		.where(and(eq(latches.id, latch.id), isNull(latches.calibratedAt)))
		.returning({ id: latches.id });
	if (latch.proposedAt === null) {
		// 未提示のまま閉じた提案は人の回答が無いため行を作らない(印だけ)
		await mark;
		return false;
	}
	const matchedAt = await matchedAtOf(db, latch.id);
	const prediction = await predictionOf(db, latch);
	const context = await contextOf(db, latch);
	const { action, survey } = await observe(db, latch, matchedAt, now);
	const outcome = outcomeOf(latch.status, matchedAt !== null);
	// INSERT … SELECT の列順は表の定義の列順(drizzleのinsert().select()・propose.tsと同じ):
	// id・latch_id・form・prediction・outcome・action・survey・context・anonymized・created_at・updated_at
	const insert = db.insert(calibrationRecords).select(
		sql`SELECT ${newUlid()}, ${latch.id}, ${latch.form}, ${JSON.stringify(prediction)}, ${outcome},
			${JSON.stringify(action)}, ${survey === null ? null : JSON.stringify(survey)}, ${JSON.stringify(context)},
			0, ${latch.proposedAt.getTime()}, ${nowMs}
			WHERE ${unmarked}`,
	);
	const [, marked] = await db.batch([insert, mark]);
	return marked.length > 0;
};

/**
 * 紐づいた(anonymized=false)行のactionを確定し、匿名化する。観測の終わりより前に
 * 呼ばれたとき(退会・Intent削除)はその時点までの観測で確定する。匿名化したらtrue
 */
export const finalizeRecord = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	now: Date,
): Promise<boolean> => {
	if (latch.proposedAt === null) return false;
	const matchedAt = await matchedAtOf(db, latch.id);
	const end = observationEndOf(latch, matchedAt);
	const until = end === null || end.getTime() > now.getTime() ? now : end;
	const { action, survey } = await observe(db, latch, matchedAt, until);
	const at = await anonymizedTimeOf(db, latch.proposedAt);
	const updated = await db
		.update(calibrationRecords)
		.set({
			latchId: null,
			action,
			survey,
			anonymized: true,
			createdAt: at,
			updatedAt: at,
		})
		.where(
			and(
				eq(calibrationRecords.latchId, latch.id),
				eq(calibrationRecords.anonymized, false),
			),
		)
		.returning({ id: calibrationRecords.id });
	return updated.length > 0;
};

/** 観測を終えてよいか(成立しなかった提案・観測の終わりを過ぎた・退会やIntent削除があった) */
const isDue = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	now: Date,
): Promise<boolean> => {
	const end = observationEndOf(latch, await matchedAtOf(db, latch.id));
	if (end === null || end.getTime() <= now.getTime()) return true;
	return mustAnonymizeNow(db, latch);
};

/** 確定して匿名化する。失敗はログを出して握る(走査の1件ごと) */
const finalizeSafely = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	now: Date,
): Promise<boolean> => {
	try {
		return (
			(await isDue(db, latch, now)) && (await finalizeRecord(db, latch, now))
		);
	} catch (error) {
		logger.warn("calibration.finalize_failed", {
			latch_id: latch.id,
			error_code: errorCodeOf(error),
		});
		return false;
	}
};

export interface CalibrationSweepOptions {
	/**
	 * 観測中の紐づいた行の点検(観測の終わり・退会・Intent削除の安全網)を行うか。
	 * 行ごとに数回の照会が要るため、毎分Cronは毎時0分(UTC)だけ行う(既定は行う)
	 */
	checkLinked?: boolean;
}

/**
 * 毎分Cronの正解データの走査(docs/06 §2)。(1)印の無い閉じた提案の行を作り、そのうち観測を
 * 終えてよいもの(成立しなかった提案など)はその場で確定して匿名化する。(2)checkLinkedのとき、
 * 観測を終えてよい紐づいた行を確定して匿名化する。1件の失敗はログを出して続行する
 */
export const runCalibrationSweep = async (
	db: DrizzleD1Database,
	now: Date,
	options: CalibrationSweepOptions = {},
): Promise<{ created: number; anonymized: number }> => {
	let created = 0;
	let anonymized = 0;
	const pending = await db
		.select()
		.from(latches)
		.where(
			and(
				isNull(latches.calibratedAt),
				inArray(latches.status, [...CLOSED_STATUSES]),
			),
		)
		.limit(SWEEP_LIMIT);
	for (const latch of pending) {
		let made = false;
		try {
			made = await createRecord(db, latch, now);
		} catch (error) {
			logger.warn("calibration.create_failed", {
				latch_id: latch.id,
				error_code: errorCodeOf(error),
			});
		}
		if (!made) continue;
		created += 1;
		if (await finalizeSafely(db, latch, now)) anonymized += 1;
	}
	if (options.checkLinked ?? true) {
		const linked = await db
			.select({ latch: latches })
			.from(calibrationRecords)
			.innerJoin(latches, eq(latches.id, calibrationRecords.latchId))
			.where(eq(calibrationRecords.anonymized, false))
			.limit(SWEEP_LIMIT);
		for (const { latch } of linked) {
			if (await finalizeSafely(db, latch, now)) anonymized += 1;
		}
	}
	if (created + anonymized > 0) {
		logger.info("calibration.swept", {
			count: created + anonymized,
		});
	}
	return { created, anonymized };
};

/**
 * 退会・Intent削除の匿名集約(docs/05 §2.5)。指定したLATCHのうち、閉じていて行の無いものは
 * 行を作り、紐づいた行はその時点までの観測で確定して匿名化する。予測をmatch_candidatesから
 * 写すため、候補の行を消す前に呼ぶ。進行中の提案は呼び出し側が先に閉じる
 */
export const anonymizeLatches = async (
	db: DrizzleD1Database,
	latchIds: string[],
	now: Date,
): Promise<number> => {
	let count = 0;
	for (let i = 0; i < latchIds.length; i += 50) {
		const chunk = latchIds.slice(i, i + 50);
		const rows = await db
			.select()
			.from(latches)
			.where(
				and(
					inArray(latches.id, chunk),
					inArray(latches.status, [...CLOSED_STATUSES]),
					sql`(${latches.calibratedAt} IS NULL OR EXISTS (SELECT 1 FROM calibration_records WHERE latch_id = ${latches.id} AND anonymized = 0))`,
				),
			);
		for (const latch of rows) {
			await createRecord(db, latch, now);
			if (await finalizeRecord(db, latch, now)) count += 1;
		}
	}
	return count;
};

/** 本人が参加者のLATCHのうち、intentIdを参加Intentに含むもの(Intent削除の匿名集約の対象) */
export const latchIdsWithIntent = async (
	db: DrizzleD1Database,
	userId: string,
	intentId: string,
): Promise<string[]> => {
	const rows = await db
		.select({ id: latches.id, intentIds: latches.intentIds })
		.from(latchMembers)
		.innerJoin(latches, eq(latches.id, latchMembers.latchId))
		.where(eq(latchMembers.userId, userId));
	return rows.filter((r) => r.intentIds.includes(intentId)).map((r) => r.id);
};
