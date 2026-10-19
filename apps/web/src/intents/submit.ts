/**
 * 読み解き確認(Confirm)の値→Intent保存リクエストの組立(docs/05 §3.2・§3.3)。
 * - つながりはexpires_in_days(7/30/90)・機会はexpires_at(既定start+3時間)で期限を運ぶ
 * - draft→active化は同じ形の全項目+status:"active"でPATCHする。
 *   クライアントはversionを送らない(楽観ロックはサーバー側のリクエスト内判定・docs/05 §3.3)
 * - 時刻の入出力はJST固定(+09:00)の壁時計として扱う(Intl・タイムゾーンDBは使わない・04 §4)
 */

import {
	BUDGET_MAX,
	type Category,
	createIntentRequestSchema,
	EXPIRY_CHOICES_DAYS,
	type IntentForm,
	isoDateTimeSchema,
	OCCASION_DEFAULT_TTL_HOURS,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
	type ParseIntentResponse,
	patchIntentRequestSchema,
} from "@latch/shared";
import type { z } from "zod";

/** 読み解き確認で編集する値(parse応答をユーザーが直せるように抜き出したもの) */
export interface ConfirmValues {
	form: IntentForm;
	/** 主題(未trimの入力値・空欄はvalidateConfirmValuesで止める) */
	topic: string;
	category: Category | null;
	/** 機会の開始(datetime-local値・JSTの壁時計)。未入力は空文字・つながりでも空文字 */
	startLocal: string;
	participants: { min: number; max: number; includes_owner: boolean };
	budget: { min: number; max: number; currency: "JPY" } | null;
	softConstraints: string[];
	alcoholInvolved: boolean;
	expiresInDays: (typeof EXPIRY_CHOICES_DAYS)[number];
}

export type CreateIntentRequest = z.infer<typeof createIntentRequestSchema>;
export type PatchIntentRequest = z.infer<typeof patchIntentRequestSchema>;

const JST_OFFSET_MS = 9 * 3_600_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** DateをJSTの暦部分へ展開する(workerのstubと同一方針・04 §4) */
const jstParts = (date: Date) => {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
	};
};

/** ISO 8601をJSTの壁時計としてdatetime-local値へ変換する(不正値は空文字) */
export const localInputFromIso = (iso: string): string => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const parts = jstParts(date);
	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
};

/** datetime-local値(JSTの壁時計)をISO 8601(Z)へ変換する(未入力・不完全はnull) */
export const isoFromLocalInput = (value: string): string | null => {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
		return null;
	}
	const date = new Date(`${value}:00+09:00`);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toISOString();
};

/** 機会の既定期限=start+3時間(docs/05 §2.2)。表示と保存で同じ規則を使う */
export const occasionDefaultExpiryIso = (startIso: string): string =>
	new Date(
		new Date(startIso).getTime() + OCCASION_DEFAULT_TTL_HOURS * MS_PER_HOUR,
	).toISOString();

/** 日付を「M月D日」で整形する(JST) */
export const formatMonthDayJst = (iso: string): string => {
	const parts = jstParts(new Date(iso));
	return `${parts.month}月${parts.day}日`;
};

/**
 * datetime-local値(JSTの壁時計)の短い表示。
 * 当日なら「今日 時:分〜」・別日なら「M月D日 時:分〜」。未入力・不完全はnull
 */
export const formatStartJst = (
	value: string,
	now: Date = new Date(),
): string | null => {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (match === null) {
		return null;
	}
	const [, year, month, day, hour, minute] = match;
	const today = jstParts(now);
	const sameDay =
		Number(year) === today.year &&
		Number(month) === today.month &&
		Number(day) === today.day;
	return `${sameDay ? "今日" : `${Number(month)}月${Number(day)}日`} ${hour}:${minute}〜`;
};

/** 期限の短い表示。当日なら「今日 時:分」・別日なら「M月D日 時:分」(JST) */
export const formatExpiryClockJst = (
	iso: string,
	now: Date = new Date(),
): string => {
	const parts = jstParts(new Date(iso));
	const today = jstParts(now);
	const clock = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
	if (
		parts.year === today.year &&
		parts.month === today.month &&
		parts.day === today.day
	) {
		return `今日 ${clock}`;
	}
	return `${parts.month}月${parts.day}日 ${clock}`;
};

/**
 * つながりの期限日の表示(expires_at_optionsの日付・05 §3.3)。
 * optionsが欠損している壊れた応答ではnow+日数へ倒す(confirmを壊さないための保険)
 */
export const connectionExpiryCaption = (
	options: readonly string[],
	days: (typeof EXPIRY_CHOICES_DAYS)[number],
	now: Date = new Date(),
): string => {
	const fromOptions = options[EXPIRY_CHOICES_DAYS.indexOf(days)];
	if (
		typeof fromOptions === "string" &&
		isoDateTimeSchema.safeParse(fromOptions).success
	) {
		return formatMonthDayJst(fromOptions);
	}
	return formatMonthDayJst(
		new Date(now.getTime() + days * MS_PER_DAY).toISOString(),
	);
};

/**
 * parse-failedの「自分で入力する」が置く空の構造化値。
 * parse応答の契約どおりの形で全欄が未設定(confirmは通常どおり読める)
 */
export const EMPTY_PARSE: ParseIntentResponse = {
	form: "connection",
	topic: "",
	category: null,
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	expires_at_options: [],
	alcohol_involved: false,
	warnings: [],
};

/**
 * 送信前のクライアント検証(行内の案内分)。
 * サーバーがactive化で検証する内容(docs/05 §2.2)と同じ項目を入力時に確かめる
 */
export const validateConfirmValues = (
	values: ConfirmValues,
	now: Date = new Date(),
): { topic?: string; start?: string } => {
	const errors: { topic?: string; start?: string } = {};
	if (values.topic.trim().length === 0) {
		errors.topic = "主題を入力してください";
	}
	if (values.form === "occasion") {
		const start = isoFromLocalInput(values.startLocal);
		if (start === null) {
			errors.start = "日時を入力してください。機会は日時が必須です";
		} else {
			const startMs = new Date(start).getTime();
			if (startMs < now.getTime()) {
				errors.start = "日時は現在以降で指定してください";
			} else if (
				startMs >
				now.getTime() + OCCASION_STARTS_AT_MAX_DAYS_AHEAD * MS_PER_DAY
			) {
				errors.start = "日時は現在から7日以内で指定してください";
			}
		}
	}
	return errors;
};

/** つながり/機会で期限の持ち方を替えて・active保存の本文を組み立てる(内部共通) */
const assembleActiveIntentBody = (
	values: ConfirmValues,
	rawText: string,
): Record<string, unknown> | null => {
	const startIso =
		values.form === "occasion" ? isoFromLocalInput(values.startLocal) : null;
	if (values.form === "occasion" && startIso === null) {
		// 機会はstarts_at必須(docs/05 §2.2)。日時が無い本文は組み立てない
		return null;
	}
	const base = {
		form: values.form,
		topic: values.topic.trim(),
		category: values.category,
		time: startIso === null ? null : { start: startIso, end: null },
		geo: null,
		participants: { ...values.participants },
		budget: values.form === "occasion" ? values.budget : null,
		hard_constraints: [] as string[],
		soft_constraints: [...values.softConstraints],
		negative_constraints: [] as string[],
		notification_level: "proposals_only" as const,
		alcohol_involved:
			values.form === "occasion" ? values.alcoholInvolved : false,
		raw_text: rawText,
		status: "active" as const,
	};
	if (values.form === "connection") {
		return { ...base, expires_in_days: values.expiresInDays };
	}
	if (startIso === null) {
		return null;
	}
	return { ...base, expires_at: occasionDefaultExpiryIso(startIso) };
};

/** 新規保存(POST /v1/intents)の本文。契約外の値はnullで返す(行内の検証で先に止める) */
export const buildCreateIntentRequest = (
	values: ConfirmValues,
	rawText: string,
): CreateIntentRequest | null => {
	const body = assembleActiveIntentBody(values, rawText);
	if (body === null) {
		return null;
	}
	const parsed = createIntentRequestSchema.safeParse(body);
	return parsed.success ? parsed.data : null;
};

/** 下書きのactive化(PATCH /v1/intents/{id})の本文。versionは含めない */
export const buildPatchIntentRequest = (
	values: ConfirmValues,
	rawText: string,
): PatchIntentRequest | null => {
	const body = assembleActiveIntentBody(values, rawText);
	if (body === null) {
		return null;
	}
	const parsed = patchIntentRequestSchema.safeParse(body);
	return parsed.success ? parsed.data : null;
};

/**
 * parse応答からConfirmの初期値を作る。
 * 人数・予算の下限/上限の整合(min<=max・2..4)はここで丸める(parse値をそのまま信じない)
 */
export const confirmValuesFromParse = (
	parse: ParseIntentResponse,
): ConfirmValues => {
	const min = Math.min(
		Math.max(parse.participants.min, PARTICIPANTS_MIN),
		PARTICIPANTS_MAX,
	);
	const max = Math.min(Math.max(parse.participants.max, min), PARTICIPANTS_MAX);
	const budget =
		parse.budget === null
			? null
			: {
					min: Math.min(Math.max(parse.budget.min, 0), BUDGET_MAX),
					max: Math.min(Math.max(parse.budget.max, 0), BUDGET_MAX),
					currency: "JPY" as const,
				};
	return {
		form: parse.form,
		topic: parse.topic,
		category: parse.category,
		startLocal: parse.time === null ? "" : localInputFromIso(parse.time.start),
		participants: { ...parse.participants, min, max, includes_owner: true },
		budget:
			budget === null
				? null
				: { ...budget, min: Math.min(budget.min, budget.max) },
		softConstraints: [],
		alcoholInvolved: parse.alcohol_involved,
		expiresInDays: EXPIRY_CHOICES_DAYS[1],
	};
};
