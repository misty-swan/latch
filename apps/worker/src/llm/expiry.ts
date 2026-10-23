/**
 * Parserの期限の選択肢(05 §2.2)をコードで求める共有部品。stubとrealが同じ計算を使う。
 * 期限はモデルに作らせない(設計書§4)。
 */
import { EXPIRY_CHOICES_DAYS, type IntentForm } from "@latch/shared";
import type { Clock } from "../clock/clock";
import { MS_PER_DAY, occasionDefaultExpiry } from "../intents/expiry";

/** JST=UTC+9の固定オフセット。Intl・タイムゾーンDBは使わない(clock.tsと同一方針・04 §4) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** DateをJSTオフセット付きISO文字列へ整形する(time.startと同一形式・04 §4) */
export const toJstIso = (date: Date): string => {
	// JSTへずらした値のUTC部分を読む
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:00+09:00`;
};

/**
 * 期限選択肢(05 §2.2): つながりはnow+7/30/90日の3件(EXPIRY_CHOICES_DAYSは昇順固定)・
 * 機会は時刻確定時のみstart+3時間の1件・日付語のみでstart未確定なら空配列。
 * time.startはJSTオフセット付きISOであること(呼び出し側が保証する)
 */
export const expiryOptions = (
	clock: Clock,
	form: IntentForm,
	time: { start: string } | null,
): string[] => {
	if (form === "occasion") {
		return time === null
			? []
			: [toJstIso(occasionDefaultExpiry(new Date(time.start)))];
	}
	return EXPIRY_CHOICES_DAYS.map((days) =>
		toJstIso(new Date(clock.now().getTime() + days * MS_PER_DAY)),
	);
};
