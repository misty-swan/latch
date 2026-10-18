/**
 * Intentの期限計算(docs/05 §2.2)。
 * つながり=active化時刻+7/30/90日(既定30日)・機会=既定start+3時間。
 * 時刻の規律(docs/04 §4)に従い現在時刻は呼び出し側から受け取り、
 * 加減算はDateのミリ秒操作のみで行う(暦・タイムゾーン操作はしない)。
 */
import {
	CONNECTION_DEFAULT_EXPIRY_DAYS,
	type EXPIRY_CHOICES_DAYS,
	OCCASION_DEFAULT_TTL_HOURS,
} from "@latch/shared";

/** 1日のミリ秒。期限の加減算はこの値の掛け算で行う */
export const MS_PER_DAY = 86_400_000;

const MS_PER_HOUR = 3_600_000;

/** つながりIntentの期限日数(7/30/90選択・docs/05 §2.2) */
export type ExpiryDays = (typeof EXPIRY_CHOICES_DAYS)[number];

/** つながりIntentのactive化時刻からの期限。days未指定は既定30日 */
export const connectionExpiry = (now: Date, days?: ExpiryDays): Date =>
	new Date(
		now.getTime() + (days ?? CONNECTION_DEFAULT_EXPIRY_DAYS) * MS_PER_DAY,
	);

/** 機会Intentの既定期限(start+3時間・docs/05 §2.2) */
export const occasionDefaultExpiry = (startsAt: Date): Date =>
	new Date(startsAt.getTime() + OCCASION_DEFAULT_TTL_HOURS * MS_PER_HOUR);
