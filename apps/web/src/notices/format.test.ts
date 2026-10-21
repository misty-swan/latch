import type { NotificationDTO } from "@latch/shared";
import { describe, expect, it } from "vitest";
import { isLiveProposal, noticeText } from "./format";

const base = {
	id: "N".repeat(26),
	read_at: null,
	created_at: "2026-10-21T00:00:00.000Z",
};
const L = "L".repeat(26);

describe("noticeText", () => {
	it("種別ごとの本文", () => {
		expect(
			noticeText({
				...base,
				type: "proposal",
				latch_id: L,
				response_deadline: "2026-10-22T00:00:00.000Z",
			} as NotificationDTO),
		).toBe("提案が届いています");
		expect(
			noticeText({
				...base,
				type: "matched",
				latch_id: L,
				display_names: ["ミナト", "ソラ"],
			} as NotificationDTO),
		).toBe("ミナト・ソラさんとつながりました");
		expect(
			noticeText({ ...base, type: "closed", latch_id: L } as NotificationDTO),
		).toBe("この提案は成立しませんでした");
		expect(
			noticeText({
				...base,
				type: "intent_expired",
				intent: { id: "I".repeat(26), raw_text: "x" },
			} as NotificationDTO),
		).toBe("預けていた意思の期限が切れました");
	});
});

describe("isLiveProposal", () => {
	const p = (deadline: string) =>
		({
			...base,
			type: "proposal",
			latch_id: L,
			response_deadline: deadline,
		}) as NotificationDTO;
	const now = new Date("2026-10-21T12:00:00.000Z");
	it("期限内だけ真", () => {
		expect(isLiveProposal(p("2026-10-21T12:00:01.000Z"), now)).toBe(true);
		expect(isLiveProposal(p("2026-10-21T12:00:00.000Z"), now)).toBe(false);
		expect(isLiveProposal(p("2026-10-21T11:00:00.000Z"), now)).toBe(false);
	});
});
