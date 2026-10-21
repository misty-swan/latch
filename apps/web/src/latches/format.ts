/**
 * 提案〜成立の画面の表示文字列(F4c設計 §表示)。prototype/app/app.jsの
 * hm・md・dayWord・when・leftの移植。時計は直接読まずnowを引数に取る。
 * 時刻はJST(UTC+9固定オフセット・Intlは使わない)。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const JST_OFFSET = 9 * HOUR;

const jstParts = (ms: number) => {
	const d = new Date(ms + JST_OFFSET);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		date: d.getUTCDate(),
		hours: d.getUTCHours(),
		minutes: d.getUTCMinutes(),
	};
};

/** JSTの暦日番号(日付境界の比較用) */
export const jstDayIndex = (ms: number): number => {
	const p = jstParts(ms);
	return Date.UTC(p.year, p.month - 1, p.date) / DAY;
};

/** JSTの時刻「H:MM」(時は0埋めなし) */
export const formatHm = (ms: number): string => {
	const p = jstParts(ms);
	return `${p.hours}:${String(p.minutes).padStart(2, "0")}`;
};

/** JSTの日付「M月D日」 */
export const formatMd = (ms: number): string => {
	const p = jstParts(ms);
	return `${p.month}月${p.date}日`;
};

/** 「今日 H:MM」「明日 H:MM」「昨日 H:MM」「M月D日 H:MM」 */
export const formatWhen = (iso: string, now: Date): string => {
	const t = new Date(iso).getTime();
	const diff = jstDayIndex(t) - jstDayIndex(now.getTime());
	const word =
		diff === 0
			? "今日"
			: diff === 1
				? "明日"
				: diff === -1
					? "昨日"
					: formatMd(t);
	return `${word} ${formatHm(t)}`;
};

/** 回答期限までの残り(「あと2日」「あと3時間5分」「あと1分」) */
export const formatLeft = (iso: string, now: Date): string => {
	const ms = new Date(iso).getTime() - now.getTime();
	if (ms <= 0) return "期限を過ぎました";
	const h = Math.floor(ms / HOUR);
	const m = Math.floor((ms % HOUR) / MIN);
	if (h >= 48) return `あと${Math.ceil(ms / DAY)}日`;
	if (h >= 1) return `あと${h}時間${m ? `${m}分` : ""}`;
	return `あと${Math.max(1, m)}分`;
};

/** 成立時刻「M月D日 H:MM」(JST) */
export const formatMatchedAt = (iso: string): string => {
	const t = new Date(iso).getTime();
	return `${formatMd(t)} ${formatHm(t)}`;
};

/** 金額「4,000円」 */
export const formatYen = (value: number): string =>
	`${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}円`;
