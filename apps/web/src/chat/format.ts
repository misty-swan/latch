/**
 * つながり一覧・チャット画面の表示文字列(F6b設計)。prototype/app/app.jsの
 * ago・chatHeadの名前まわりの移植。時計は直接読まずnowを引数に取る。
 * 時刻はJST(UTC+9固定オフセット・Intlは使わない)。
 */
import type { LatchDTO } from "@latch/shared";
import { formatHm, formatMd, jstDayIndex } from "../latches/format";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 成立後に取り消された(または名前を開示できない)相手の表示名 */
export const ENDED_PARTNER_NAME = "つながっていた相手";

/** 終了したつながり(completedまたはcancelled) */
export const isEndedConnection = (latch: LatchDTO): boolean =>
	latch.status === "completed" || latch.status === "cancelled";

/** 一覧・見出しの名前。cancelledは実名を出さない */
export const connectionName = (latch: LatchDTO): string => {
	if (latch.status === "cancelled") return ENDED_PARTNER_NAME;
	const names = (latch.members ?? []).map((m) => m.display_name);
	return names.length > 0 ? names.join("・") : ENDED_PARTNER_NAME;
};

/** 副題の要素(画面が区切り点でつなぐ): [主題, 形式, 終了なら「終了」] */
export const connectionSubtitle = (latch: LatchDTO): string[] => {
	const parts: string[] = [];
	const topic = latch.proposal?.topic;
	if (topic) parts.push(topic);
	parts.push(latch.form === "occasion" ? "機会" : "つながり");
	if (isEndedConnection(latch)) parts.push("終了");
	return parts;
};

/** 送信者名。cancelledや、membersに居なければ(離脱・自分以外の不明者)つながっていた相手 */
export const senderName = (latch: LatchDTO, userId: string): string => {
	if (latch.status === "cancelled") return ENDED_PARTNER_NAME;
	return (
		latch.members?.find((m) => m.user_id === userId)?.display_name ??
		ENDED_PARTNER_NAME
	);
};

/** 経過表示「いま」「N分前」「H:MM」「昨日」「N日前」「M月D日」 */
export const formatAgo = (iso: string, now: Date): string => {
	const t = new Date(iso).getTime();
	const ms = now.getTime() - t;
	if (ms < MIN) return "いま";
	if (ms < HOUR) return `${Math.floor(ms / MIN)}分前`;
	const dd = jstDayIndex(now.getTime()) - jstDayIndex(t);
	if (dd === 0) return formatHm(t);
	if (dd === 1) return "昨日";
	if (dd < 7) return `${dd}日前`;
	return formatMd(t);
};

/** 日付区切りの見出し「今日」「M月D日」 */
export const formatDayLabel = (iso: string, now: Date): string => {
	const t = new Date(iso).getTime();
	return jstDayIndex(t) === jstDayIndex(now.getTime()) ? "今日" : formatMd(t);
};

/** 2つの時刻がJSTで同じ日か */
export const isSameJstDay = (a: string, b: string): boolean =>
	jstDayIndex(new Date(a).getTime()) === jstDayIndex(new Date(b).getTime());
