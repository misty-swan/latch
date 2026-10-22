import { describe, expect, it } from "vitest";
import {
	assertWithinStartLimit,
	BURST_LEAD_SEC,
	baseStartMs,
	CHAT_PAIR_SPACING_MS,
	maxDurationSec,
	maxPairsWithinStartLimit,
	PAIR_SPACING_MS,
	pairStartMs,
	pairSubjects,
	parseMode,
} from "./pairs.mjs";

const HOUR = 3_600_000;

describe("parseMode", () => {
	it("未指定はstaggered", () => {
		expect(parseMode(undefined)).toBe("staggered");
		expect(parseMode("")).toBe("staggered");
	});
	it("staggered・burstはそのまま", () => {
		expect(parseMode("staggered")).toBe("staggered");
		expect(parseMode("burst")).toBe("burst");
	});
	it("それ以外は例外", () => {
		expect(() => parseMode("b")).toThrow(
			"MODEはstaggered((b))かburst((d))で指定してください",
		);
	});
});

describe("baseStartMs", () => {
	it("実行時刻+24時間を1時間単位に切り上げる", () => {
		const now = Date.UTC(2026, 9, 22, 15, 30, 12);
		expect(baseStartMs(now)).toBe(Date.UTC(2026, 9, 23, 16, 0, 0));
	});
	it("ちょうど正時なら+24時間そのまま", () => {
		const now = Date.UTC(2026, 9, 22, 15, 0, 0);
		expect(baseStartMs(now)).toBe(Date.UTC(2026, 9, 23, 15, 0, 0));
	});
});

describe("pairStartMs", () => {
	it("組kは基準+k×3時間", () => {
		const base = Date.UTC(2026, 9, 23, 16);
		expect(pairStartMs(base, 0)).toBe(base);
		expect(pairStartMs(base, 2)).toBe(base + 6 * HOUR);
	});
	it("隣の組とは時間帯(2時間の幅)が重ならない", () => {
		const base = Date.UTC(2026, 9, 23, 16);
		const end0 = pairStartMs(base, 0) + 2 * HOUR;
		expect(pairStartMs(base, 1) - end0).toBe(PAIR_SPACING_MS - 2 * HOUR);
		expect(pairStartMs(base, 1)).toBeGreaterThan(end0);
	});
	it("30組の最後の開始でも機会の開始の上限(7日以内)に収まる", () => {
		const now = Date.UTC(2026, 9, 22, 15, 30);
		const last = pairStartMs(baseStartMs(now), 29);
		expect(last - now).toBeLessThan(7 * 24 * HOUR);
	});
	it("(c)は間隔2時間を渡せ、50組の最後の開始でも7日以内に収まる", () => {
		const now = Date.UTC(2026, 9, 22, 15, 30);
		const base = baseStartMs(now);
		expect(pairStartMs(base, 1, CHAT_PAIR_SPACING_MS)).toBe(base + 2 * HOUR);
		expect(pairStartMs(base, 49, CHAT_PAIR_SPACING_MS) - now).toBeLessThan(
			7 * 24 * HOUR,
		);
		// 3時間の間隔のままでは上限を超える
		expect(pairStartMs(base, 49) - now).toBeGreaterThan(7 * 24 * HOUR);
	});
	it("(c)の隣の組とは重なりが0分(Layer 1の下限15分を下回る)", () => {
		const base = Date.UTC(2026, 9, 23, 16);
		const end0 = pairStartMs(base, 0, CHAT_PAIR_SPACING_MS) + 2 * HOUR;
		expect(pairStartMs(base, 1, CHAT_PAIR_SPACING_MS)).toBe(end0);
	});
});

describe("pairSubjects", () => {
	it("(b)は組kが連番2k+1と2k+2", () => {
		expect(pairSubjects("202610221530", "staggered", 0)).toEqual([
			"load-202610221530-b1",
			"load-202610221530-b2",
		]);
		expect(pairSubjects("202610221530", "staggered", 5)).toEqual([
			"load-202610221530-b11",
			"load-202610221530-b12",
		]);
	});
	it("(d)はdの印", () => {
		expect(pairSubjects("202610221530", "burst", 1)).toEqual([
			"load-202610221530-d3",
			"load-202610221530-d4",
		]);
	});
	it("(c)はcの印", () => {
		expect(pairSubjects("202610221530", "chat", 0)).toEqual([
			"load-202610221530-c1",
			"load-202610221530-c2",
		]);
	});
	it("知らない種類は例外", () => {
		expect(() => pairSubjects("202610221530", "x", 0)).toThrow(
			"組の種類が不正です(x)",
		);
	});
});

describe("maxDurationSec", () => {
	it("(b)は最後の組の投入まで+提案待ち+余裕120秒", () => {
		expect(maxDurationSec("staggered", 30, 60)).toBe(58 + 60 + 120);
		expect(maxDurationSec("staggered", 6, 900)).toBe(10 + 900 + 120);
	});
	it("(d)は一斉投入までの間+提案待ち+余裕120秒", () => {
		expect(maxDurationSec("burst", 30, 60)).toBe(BURST_LEAD_SEC + 60 + 120);
	});
});

describe("maxPairsWithinStartLimit・assertWithinStartLimit", () => {
	it("組数の上限は(b)(d)が48組・(c)が72組", () => {
		expect(maxPairsWithinStartLimit()).toBe(48);
		expect(maxPairsWithinStartLimit(CHAT_PAIR_SPACING_MS)).toBe(72);
	});
	it("基準時刻が最も遅い(正時の直後)ときも上限の組数なら収まり、1組多いと例外", () => {
		const now = Date.UTC(2026, 9, 22, 15, 0, 1);
		expect(() => assertWithinStartLimit(now, 48)).not.toThrow();
		expect(() => assertWithinStartLimit(now, 49)).toThrow(
			"組数49では最後の組の開始が機会の開始の上限(7日以内)を超えます。LOAD_SCALEを下げてください(この間隔での組数の上限は48組)",
		);
		expect(() =>
			assertWithinStartLimit(now, 72, CHAT_PAIR_SPACING_MS),
		).not.toThrow();
		expect(() => assertWithinStartLimit(now, 73, CHAT_PAIR_SPACING_MS)).toThrow(
			"組数の上限は72組",
		);
	});
	it("既定の規模((b)(d)30組・(c)50組)は収まる", () => {
		const now = Date.UTC(2026, 9, 22, 15, 30);
		expect(() => assertWithinStartLimit(now, 30)).not.toThrow();
		expect(() =>
			assertWithinStartLimit(now, 50, CHAT_PAIR_SPACING_MS),
		).not.toThrow();
	});
});
