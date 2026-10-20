import { describe, expect, it } from "vitest";
import { formatLeft, formatMatchedAt, formatWhen, formatYen } from "./format";

const NOW = new Date("2026-10-16T09:20:00Z"); // JST 18:20
const plus = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("formatLeft", () => {
	it("期限ちょうどは期限を過ぎました", () => {
		expect(formatLeft(plus(0), NOW)).toBe("期限を過ぎました");
	});
	it("47時間59分はあと47時間59分", () => {
		expect(formatLeft(plus(47 * HOUR + 59 * MIN), NOW)).toBe("あと47時間59分");
	});
	it("48時間はあと2日", () => {
		expect(formatLeft(plus(48 * HOUR), NOW)).toBe("あと2日");
	});
	it("3時間0分はあと3時間", () => {
		expect(formatLeft(plus(3 * HOUR), NOW)).toBe("あと3時間");
	});
	it("30秒はあと1分", () => {
		expect(formatLeft(plus(30_000), NOW)).toBe("あと1分");
	});
});

describe("formatWhen", () => {
	it("JSTの日付境界で今日/明日を切り替える", () => {
		// JST 2026-10-16 23:59 = UTC 14:59 / JST 10-17 00:00 = UTC 15:00
		const now = new Date("2026-10-16T14:59:00Z");
		expect(formatWhen("2026-10-16T14:59:00Z", now)).toBe("今日 23:59");
		expect(formatWhen("2026-10-16T15:00:00Z", now)).toBe("明日 0:00");
	});
	it("昨日と、それ以外はM月D日", () => {
		expect(formatWhen("2026-10-15T00:05:00Z", NOW)).toBe("昨日 9:05");
		expect(formatWhen("2026-10-20T10:00:00Z", NOW)).toBe("10月20日 19:00");
	});
});

describe("formatMatchedAt / formatYen", () => {
	it("成立時刻はM月D日 H:MM(JST)", () => {
		expect(formatMatchedAt("2026-10-16T14:59:00Z")).toBe("10月16日 23:59");
		expect(formatMatchedAt("2026-10-16T15:00:00Z")).toBe("10月17日 0:00");
	});
	it("円は3桁区切り", () => {
		expect(formatYen(4000)).toBe("4,000円");
		expect(formatYen(1234567)).toBe("1,234,567円");
	});
});
