/**
 * Intent Parserのstub(docs/07 §2(a)・§3)。規則ベースの抽出のみでLLMを呼ばない。
 * 決定的(同一入力+同一clock→同一出力)であることを仕様とする(07 §2)。
 */
import { EXPIRY_CHOICES_DAYS, type IntentForm, LIMITS } from "@latch/shared";
import type { Clock } from "../../clock/clock";
import { MS_PER_DAY, occasionDefaultExpiry } from "../../intents/expiry";
import type { ParserStubOutput } from "../types";

/** JST=UTC+9の固定オフセット。Intl・タイムゾーンDBは使わない(clock.tsと同一方針・04 §4) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 時刻語。「半」は30分に読む(07 §3) */
const TIME_WORD = /(\d{1,2})時(半)?/;

/** 日付語。時刻までは確定しないが機会Intent(form=occasion)の根拠になる(07 §3) */
const DATE_WORD = /(今日|明日|明後日|\d{1,2}日|(日|月|火|水|木|金|土)曜)/;

/** 金額。「くらい/ぐらい/程度」も確定値へ丸める(07 §3) */
const AMOUNT = /(\d{3,6})円(くらい|ぐらい|程度)?/;

/** 人数の幅。「2人〜4人」「2〜4人」の両表記を受ける(07 §3) */
const PARTICIPANT_RANGE = /(\d{1,2})人?[〜~ー-](\d{1,2})人/;

/** 単独の人数表記 */
const PARTICIPANT_SINGLE = /(\d{1,2})人/;

/** 飲酒を示唆する語の辞書(部分一致・07 §3)。見逃しゼロ(recall優先)のため広めに取る */
const ALCOHOL_WORDS = [
	"飲み",
	"飲み会",
	"飲酒",
	"酒",
	"ビール",
	"ワイン",
	"日本酒",
	"焼酎",
	"サワー",
	"ハイボール",
	"カクテル",
	"バー",
	"居酒屋",
	"酒場",
	"缶チューハイ",
] as const;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** DateをJSTオフセット付きISO文字列へ整形する(time.startと同一形式・04 §4) */
const toJstIso = (date: Date): string => {
	// JSTへずらした値のUTC部分を読む(nextJstDayと同一方針)
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:00+09:00`;
};

/** clock基準日のJST翌日の年月日を求める(時刻語は「基準日のJST翌日のその時刻」と解釈・07 §3) */
const nextJstDay = (
	clock: Clock,
): { year: number; month: number; day: number } => {
	// JSTへずらした値のUTC部分で年月日を扱い、翌日へ進める(月・年またぎはDateに委ねる)
	const shifted = new Date(clock.now().getTime() + JST_OFFSET_MS);
	shifted.setUTCDate(shifted.getUTCDate() + 1);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
	};
};

/** topic=先頭から最初の改行・句点(。)までを上限40字で切り詰める(07 §3・04 §5) */
const extractTopic = (raw_text: string): string => {
	const cutAt = raw_text.search(/[\n。]/);
	const head = cutAt === -1 ? raw_text : raw_text.slice(0, cutAt);
	return head.slice(0, LIMITS.TOPIC_MAX_LENGTH);
};

/** raw_textを規則ベースで構造化する(07 §2(a)・§3) */
export const stubParse = (raw_text: string, clock: Clock): ParserStubOutput => {
	// form判定: 時刻語→機会(時刻確定)・日付語のみ→機会(時刻null)・
	// どちらもなし→より安全な側のつながり(07 §3)
	const timeMatch = TIME_WORD.exec(raw_text);
	const dateMatch = DATE_WORD.exec(raw_text);

	let form: IntentForm = "connection";
	let time: ParserStubOutput["time"] = null;
	if (timeMatch !== null) {
		form = "occasion";
		const hour = Number(timeMatch[1]);
		const minute = timeMatch[2] === undefined ? 0 : 30;
		const { year, month, day } = nextJstDay(clock);
		time = {
			start: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+09:00`,
			end: null,
		};
	} else if (dateMatch !== null) {
		form = "occasion";
	}

	// 金額: min=maxへ丸める(07 §3)
	const amountMatch = AMOUNT.exec(raw_text);
	let budget: ParserStubOutput["budget"] = null;
	if (amountMatch !== null) {
		const amount = Number(amountMatch[1]);
		budget = { min: amount, max: amount };
	}

	// 人数: 幅表記→{min,max}・単独→min=max・既定{2,2}(07 §3)
	const rangeMatch = PARTICIPANT_RANGE.exec(raw_text);
	const singleMatch =
		rangeMatch === null ? PARTICIPANT_SINGLE.exec(raw_text) : null;
	let participants: ParserStubOutput["participants"] = { min: 2, max: 2 };
	if (rangeMatch !== null) {
		participants = { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
	} else if (singleMatch !== null) {
		const count = Number(singleMatch[1]);
		participants = { min: count, max: count };
	}

	// 飲酒: 辞書の部分一致(07 §3)
	const alcohol_involved = ALCOHOL_WORDS.some((word) =>
		raw_text.includes(word),
	);

	// 期限選択肢(05 §2.2): つながりはnow+7/30/90日の3件(EXPIRY_CHOICES_DAYSは昇順固定)・
	// 機会は時刻確定時のみstart+3時間の1件・日付語のみでstart未確定なら空配列
	let expires_at_options: string[] = EXPIRY_CHOICES_DAYS.map((days) =>
		toJstIso(new Date(clock.now().getTime() + days * MS_PER_DAY)),
	);
	if (form === "occasion") {
		// time.startは直上で生成した+09:00付きISOのためnew Dateで確実にパースできる
		expires_at_options =
			time === null
				? []
				: [toJstIso(occasionDefaultExpiry(new Date(time.start)))];
	}

	return {
		form,
		topic: extractTopic(raw_text),
		category: null,
		time,
		participants,
		budget,
		alcohol_involved,
		expires_at_options,
		warnings: [],
	};
};
