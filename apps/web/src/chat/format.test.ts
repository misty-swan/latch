import type { LatchDTO } from "@latch/shared";
import { describe, expect, it } from "vitest";
import {
	connectionName,
	connectionSubtitle,
	ENDED_PARTNER_NAME,
	formatAgo,
	formatDayLabel,
	isEndedConnection,
	isSameJstDay,
	senderName,
} from "./format";

const NOW = new Date("2026-10-16T09:20:00Z"); // JST 18:20
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const member = (user_id: string, display_name: string) => ({
	user_id,
	display_name,
	bio: null,
	has_icon: false,
});

const latch = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "l1",
		form: "connection",
		status: "matched",
		members: [member("u2", "ゆう")],
		proposal: { topic: "イラスト仲間" },
		...over,
	}) as LatchDTO;

describe("formatAgo", () => {
	it("30秒前はいま", () => {
		expect(formatAgo(ago(30_000), NOW)).toBe("いま");
	});
	it("59分前は59分前", () => {
		expect(formatAgo(ago(59 * MIN), NOW)).toBe("59分前");
	});
	it("同じ日の3時間前は H:MM", () => {
		expect(formatAgo(ago(3 * HOUR), NOW)).toBe("15:20");
	});
	it("JSTの前日は昨日(UTC 14:59と15:00をまたぐ)", () => {
		const now = new Date("2026-10-16T15:00:00Z"); // JST 10-17 00:00
		// JST 10-16 22:00(2時間前だが日付は前日)
		expect(formatAgo("2026-10-16T13:00:00Z", now)).toBe("昨日");
		// JST 10-17 00:00 ちょうどの2時間後は同じ日
		const later = new Date("2026-10-16T17:00:00Z");
		expect(formatAgo("2026-10-16T15:00:00Z", later)).toBe("0:00");
	});
	it("6日前は6日前", () => {
		expect(formatAgo(ago(6 * DAY), NOW)).toBe("6日前");
	});
	it("7日前は M月D日", () => {
		expect(formatAgo(ago(7 * DAY), NOW)).toBe("10月9日");
	});
});

describe("formatDayLabel", () => {
	it("同じ日は今日", () => {
		expect(formatDayLabel(ago(3 * HOUR), NOW)).toBe("今日");
	});
	it("前日は M月D日", () => {
		expect(formatDayLabel(ago(DAY), NOW)).toBe("10月15日");
	});
});

describe("isSameJstDay", () => {
	it("JSTの日付境界で分かれる", () => {
		expect(isSameJstDay("2026-10-16T14:59:00Z", "2026-10-16T15:00:00Z")).toBe(
			false,
		);
		expect(isSameJstDay("2026-10-15T15:00:00Z", "2026-10-16T14:59:00Z")).toBe(
			true,
		);
	});
});

describe("isEndedConnection", () => {
	it("completedとcancelledは終了、matchedは続いている", () => {
		expect(isEndedConnection(latch({ status: "completed" }))).toBe(true);
		expect(isEndedConnection(latch({ status: "cancelled" }))).toBe(true);
		expect(isEndedConnection(latch())).toBe(false);
	});
});

describe("connectionName", () => {
	it("matched 1対1は相手名", () => {
		expect(connectionName(latch())).toBe("ゆう");
	});
	it("グループは・でつなぐ", () => {
		const l = latch({
			members: [member("u2", "ゆう"), member("u3", "ちひろ")],
		});
		expect(connectionName(l)).toBe("ゆう・ちひろ");
	});
	it("completedは実名", () => {
		expect(connectionName(latch({ status: "completed" }))).toBe("ゆう");
	});
	it("cancelledはつながっていた相手", () => {
		expect(connectionName(latch({ status: "cancelled" }))).toBe(
			ENDED_PARTNER_NAME,
		);
	});
	it("membersが空ならつながっていた相手", () => {
		expect(connectionName(latch({ members: [] }))).toBe(ENDED_PARTNER_NAME);
		expect(connectionName(latch({ members: undefined }))).toBe(
			ENDED_PARTNER_NAME,
		);
	});
});

describe("connectionSubtitle", () => {
	it("matchedは主題と形式", () => {
		expect(connectionSubtitle(latch())).toEqual(["イラスト仲間", "つながり"]);
	});
	it("completedは終了を足す", () => {
		expect(connectionSubtitle(latch({ status: "completed" }))).toEqual([
			"イラスト仲間",
			"つながり",
			"終了",
		]);
	});
	it("主題がnullなら形式から始まる", () => {
		const l = latch({
			form: "occasion",
			proposal: { topic: null },
		} as Partial<LatchDTO>);
		expect(connectionSubtitle(l)).toEqual(["機会"]);
	});
});

describe("senderName", () => {
	it("membersに居ればその名前", () => {
		expect(senderName(latch(), "u2")).toBe("ゆう");
	});
	it("居なければつながっていた相手", () => {
		expect(senderName(latch(), "u9")).toBe(ENDED_PARTNER_NAME);
	});
	it("cancelledならmembersに居てもつながっていた相手", () => {
		expect(senderName(latch({ status: "cancelled" }), "u2")).toBe(
			ENDED_PARTNER_NAME,
		);
	});
});
