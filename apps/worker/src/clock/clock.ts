/**
 * 時刻の規律(docs/04 §4)。
 * 製品コードは実時間を直接参照しない。現在時刻は必ずこのclock経由で受け取り、
 * 単体試験はfixedClockによる固定時刻で行う。
 * JST基準の集計・リセット(docs/01 §20)用のバケットキー生成もここに置く。
 */

/** 現在時刻の供給源。製品コードはDate.now()/new Date()を直接呼ばず、これ経由で時刻を得る */
export interface Clock {
	now(): Date;
}

/** 実時間を返すclock(この実装内部でのみ現在時刻を直接参照してよい) */
export const systemClock: Clock = {
	now: () => new Date(),
};

/** テスト用の固定時刻clock。渡された時刻をエポックミリ秒で固定し、以後常に同一時刻を返す */
export const fixedClock = (at: Date): Clock => {
	const fixedMs = at.getTime();
	return {
		now: () => new Date(fixedMs),
	};
};

/** JST=UTC+9の固定オフセット。タイムゾーンデータベース・Intlは使わない(Workersランタイムで一貫させる) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** JSTにずらした値をUTC部分として取り出し、年月日時を得る(固定オフセット計算のみ) */
const jstParts = (
	d: Date,
): { year: number; month: number; day: number; hour: number } => {
	const shifted = new Date(d.getTime() + JST_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
	};
};

/** 日次バケットキー(usage_countersのperiod・docs/05 §2.2): YYYY-MM-DD(JST基準) */
export const jstDayKey = (d: Date): string => {
	const { year, month, day } = jstParts(d);
	return `${year}-${pad2(month)}-${pad2(day)}`;
};

/** 時間バケットキー(usage_countersのperiod・docs/05 §2.2): YYYY-MM-DD-HH(JST基準) */
export const jstHourKey = (d: Date): string => {
	const { year, month, day, hour } = jstParts(d);
	return `${year}-${pad2(month)}-${pad2(day)}-${pad2(hour)}`;
};

/** 月次バケットキー(usage_countersのperiod・docs/05 §2.2): YYYY-MM(JST基準) */
export const jstMonthKey = (d: Date): string => {
	const { year, month } = jstParts(d);
	return `${year}-${pad2(month)}`;
};

/** 当日JST 0時のUTC時刻(日次集計・通知上限の窓の起点・docs/01 §20) */
export const jstDayStart = (d: Date): Date => {
	const { year, month, day } = jstParts(d);
	return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
};
