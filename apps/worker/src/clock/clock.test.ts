import { describe, expect, it } from "vitest";
import {
	fixedClock,
	jstDayKey,
	jstDayStart,
	jstHourKey,
	jstMonthKey,
	systemClock,
} from "./clock";

describe("fixedClock(04 §4: 単体試験は固定時刻で行う)", () => {
	it("now()は何度呼んでも同一の時刻を返す", () => {
		const clock = fixedClock(new Date("2026-10-17T01:02:03Z"));
		const first = clock.now();
		const second = clock.now();
		expect(second.getTime()).toBe(first.getTime());
		expect(first.toISOString()).toBe("2026-10-17T01:02:03.000Z");
	});

	it("構成時に渡したDateを後から書き換えても now() は影響を受けない", () => {
		const at = new Date("2026-10-17T01:02:03Z");
		const clock = fixedClock(at);
		at.setTime(0);
		expect(clock.now().toISOString()).toBe("2026-10-17T01:02:03.000Z");
	});
});

describe("jstDayKey(usage_countersのperiod・05 §2.2)", () => {
	it("JST 23:59:59(UTC 14:59:59)は当日の日次キー", () => {
		expect(jstDayKey(new Date("2026-10-17T14:59:59Z"))).toBe("2026-10-17");
	});

	it("JST 0:00:00(UTC 15:00:00)は翌日の日次キー", () => {
		expect(jstDayKey(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10-18");
	});

	it("月・日のゼロ埋め(UTC+9で月をまたぐ境界)", () => {
		expect(jstDayKey(new Date("2026-01-01T15:30:00Z"))).toBe("2026-01-02");
		expect(jstDayKey(new Date("2026-12-31T14:00:00Z"))).toBe("2026-12-31");
	});
});

describe("jstHourKey(usage_countersのperiod・05 §2.2)", () => {
	it("JST 0:00:00(UTC 15:00:00)は翌日0時の時間キー", () => {
		expect(jstHourKey(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10-18-00");
	});

	it("日次キーと同じ境界・JST 23時台(UTC 14時台)", () => {
		expect(jstHourKey(new Date("2026-10-17T14:59:59Z"))).toBe("2026-10-17-23");
		expect(jstHourKey(new Date("2026-10-17T14:00:00Z"))).toBe("2026-10-17-23");
	});

	it("月・日・時のゼロ埋め", () => {
		expect(jstHourKey(new Date("2026-01-01T15:30:00Z"))).toBe("2026-01-02-00");
		expect(jstHourKey(new Date("2026-04-05T06:00:00Z"))).toBe("2026-04-05-15");
	});
});

describe("jstMonthKey(月次バケット・Jev予算の1か月カウンタ)", () => {
	it("JST換算で月が変わる境界(UTC 10/31 15:00は11月)", () => {
		expect(jstMonthKey(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11");
		expect(jstMonthKey(new Date("2026-10-31T14:59:59Z"))).toBe("2026-10");
	});
});

describe("jstDayStart(当日JST 0時のUTC時刻)", () => {
	it("JST 1:00(UTC 前日16:00)でも当日JST 0時を返す", () => {
		expect(jstDayStart(new Date("2026-10-20T16:00:00Z")).toISOString()).toBe(
			"2026-10-20T15:00:00.000Z",
		);
	});

	it("JST 0:00ちょうどはそのまま、直前は前日の0時", () => {
		expect(jstDayStart(new Date("2026-10-19T15:00:00Z")).toISOString()).toBe(
			"2026-10-19T15:00:00.000Z",
		);
		expect(jstDayStart(new Date("2026-10-19T14:59:59Z")).toISOString()).toBe(
			"2026-10-18T15:00:00.000Z",
		);
	});
});

describe("systemClock(04 §4: 現在時刻はclock経由のみ)", () => {
	// 実測比較なので、ここでのみ Date.now() の直接参照を許す(04 §4の時刻規律)
	it("now()が現在時刻の±60秒以内を返す", () => {
		const before = Date.now();
		const now = systemClock.now();
		const after = Date.now();
		expect(now.getTime()).toBeGreaterThanOrEqual(before - 60_000);
		expect(now.getTime()).toBeLessThanOrEqual(after + 60_000);
	});

	it("now()はDateを返す", () => {
		expect(systemClock.now()).toBeInstanceOf(Date);
	});
});
