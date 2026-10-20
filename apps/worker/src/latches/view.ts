/**
 * LATCHの表示範囲(F4a設計 §4.5・docs/01 §10)。
 * 成立前は相手の情報・proposalを一切含めない(キー自体を出さない・#20)。
 * 成立後(matched・およびmatched経由のcancelled)のみproposalと自分を除くmembersを含める
 */
import {
	type LatchDTO,
	type LatchResponseValue,
	latchProposalSchema,
} from "@latch/shared";
import type { latches, users } from "../db/schema";
import { toUserDto } from "../routes/users";

export interface LatchDtoOptions {
	participantsCount: number;
	myResponse: LatchResponseValue | null;
	/** 自分側の参加Intent(latches.intent_idsのうちintents.user_idが自分のもの・F4c設計 §2) */
	myIntentId: string;
	/** 成立時刻(to=matchedの状態記録のcreated_at)。成立を経ていなければnull */
	matchedAt: Date | null;
	/** 自分を除く参加者。成立後(matched経由)のときだけ渡す。渡さなければ成立前の形 */
	members?: (typeof users.$inferSelect)[];
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
			const { display_name, bio, has_icon } = toUserDto(u);
			return { user_id: u.id, display_name, bio, has_icon };
		});
	}
	return dto;
};
