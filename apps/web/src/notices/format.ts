/**
 * お知らせ一覧の表示文字列(F7c設計)。prototype/app/app.jsのscreens.noticesの移植。
 * 時計は直接読まずnowを引数に取る。
 */
import type { NotificationDTO } from "@latch/shared";

/** 行の本文 */
export const noticeText = (n: NotificationDTO): string => {
	switch (n.type) {
		case "proposal":
			return "提案が届いています";
		case "matched":
			return n.display_names.length > 0
				? `${n.display_names.join("・")}さんとつながりました`
				: "つながりました";
		case "closed":
			return "この提案は成立しませんでした";
		case "intent_expired":
			return "預けていた意思の期限が切れました";
	}
};

/** 回答期限内の提案か(期限を過ぎたら「回答期限 … まで」を出さない) */
export const isLiveProposal = (n: NotificationDTO, now: Date): boolean =>
	n.type === "proposal" &&
	new Date(n.response_deadline).getTime() > now.getTime();
