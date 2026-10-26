/**
 * LATCHの表示範囲(F4a設計 §4.5・docs/01 §10)。
 * 成立前は相手の情報・proposalを一切含めない(キー自体を出さない・#20)。
 * 成立後(matched・completed・およびmatched経由のcancelled)のみproposalと自分を除くmembersを含める
 */
import {
	type LatchDTO,
	type LatchFeedbackKind,
	type LatchResponseValue,
	latchProposalSchema,
} from "@latch/shared";
import type { latches, users } from "../db/schema";
import { toUserDto } from "../routes/users";
import { DELETED_DISPLAY_NAME } from "../safety/block";

export interface LatchDtoOptions {
	participantsCount: number;
	myResponse: LatchResponseValue | null;
	/** 自分側の参加Intent(latches.intent_idsのうちintents.user_idが自分のもの。Intent削除済みで見つからなければnull・F4c設計 §2) */
	myIntentId: string | null;
	/** 成立時刻(to=matchedの状態記録のcreated_at)。成立を経ていなければnull */
	matchedAt: Date | null;
	/** 自分を除く参加者。成立後(matched経由)のときだけ渡す。渡さなければ成立前の形 */
	members?: (typeof users.$inferSelect)[];
	/** 最終メッセージと本人の未読数。membersと同じく成立後(matched経由)のときだけ渡す(F6a設計 §3.2) */
	chat?: {
		lastMessage: { body: string; createdAt: Date; userId: string } | null;
		unreadCount: number;
	};
	/** 本人に今たずねる自己申告の種別(docs/05 §3.3)。membersと同じく成立後だけ渡す */
	feedbackDue?: LatchFeedbackKind | null;
}

export const toLatchDto = (
	latch: typeof latches.$inferSelect,
	opts: LatchDtoOptions,
): LatchDTO => {
	const dto: LatchDTO = {
		id: latch.id,
		form: latch.form,
		status: latch.status,
		response_deadline: latch.responseDeadline.toISOString(),
		participants_count: opts.participantsCount,
		my_response: opts.myResponse,
		score: latch.score,
		my_intent_id: opts.myIntentId,
		matched_at: opts.matchedAt === null ? null : opts.matchedAt.toISOString(),
	};
	if (opts.members !== undefined) {
		dto.proposal = latchProposalSchema.parse(latch.proposal);
		dto.members = opts.members.map((u) => {
			// 退会した参加者(終了後のLATCHに残る)は名前・ひとこと・アイコンを出さない(docs/05 §2.5)
			if (u.status !== "active") {
				return {
					user_id: u.id,
					display_name: DELETED_DISPLAY_NAME,
					bio: "",
					has_icon: false,
				};
			}
			const { display_name, bio, has_icon } = toUserDto(u);
			return { user_id: u.id, display_name, bio, has_icon };
		});
	}
	if (opts.chat !== undefined) {
		dto.last_message =
			opts.chat.lastMessage === null
				? null
				: {
						body: opts.chat.lastMessage.body,
						created_at: opts.chat.lastMessage.createdAt.toISOString(),
						user_id: opts.chat.lastMessage.userId,
					};
		dto.unread_count = opts.chat.unreadCount;
	}
	if (opts.feedbackDue !== undefined) {
		dto.feedback_due = opts.feedbackDue;
	}
	return dto;
};
