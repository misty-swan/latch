import { describe, expect, it } from "vitest";
import {
	judgeDurations,
	notifyDurations,
	p95,
	renderTable,
	summarize,
} from "./stats.mjs";

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe("p95", () => {
	it("空はnull", () => expect(p95([])).toBeNull());
	it("1件はその値", () => expect(p95([5])).toBe(5));
	it("1〜100は95", () => expect(p95(range(100))).toBe(95));
	it("1〜20は19", () => expect(p95(range(20))).toBe(19));
	it("入力の順序に依らず、入力を書き換えない", () => {
		const v = [3, 1, 2];
		expect(p95(v)).toBe(3);
		expect(v).toEqual([3, 1, 2]);
	});
});

describe("summarize", () => {
	it("nullは欠けとして数える", () => {
		expect(summarize("初期判定", 10000, [1000, null, 3000])).toEqual({
			name: "初期判定",
			targetMs: 10000,
			total: 3,
			measured: 2,
			missing: 1,
			p95Ms: 3000,
			pass: true,
		});
	});
	it("目標を超えると不合格", () => {
		expect(summarize("x", 2000, [1000, 3000]).pass).toBe(false);
	});
	it("計測が0件ならp95Msもpassもnull", () => {
		const s = summarize("通知", 5000, [null]);
		expect(s.measured).toBe(0);
		expect(s.p95Ms).toBeNull();
		expect(s.pass).toBeNull();
	});
});

describe("judgeDurations / notifyDurations", () => {
	it("pushAttemptedAt−activatedAt、未送信はnull", () => {
		expect(
			judgeDurations([
				{ activatedAt: 100, pushAttemptedAt: 2600 },
				{ activatedAt: 100, pushAttemptedAt: null },
			]),
		).toEqual([2500, null]);
	});
	it("通知はcreatedAtからの差", () => {
		expect(
			notifyDurations([
				{ createdAt: 10, pushAttemptedAt: 40 },
				{ createdAt: 10, pushAttemptedAt: null },
			]),
		).toEqual([30, null]);
	});
});

describe("renderTable", () => {
	it("nullは計測なしと—、ミリ秒は秒へ", () => {
		const out = renderTable([
			summarize("初期判定", 10000, [420]),
			summarize("通知", 5000, [null]),
			summarize("遅い", 100, [420]),
		]);
		const lines = out.split("\n");
		expect(lines[0]).toBe("| 項目 | 目標 | 対象 | 計測 | 欠け | p95 | 判定 |");
		expect(lines[2]).toBe("| 初期判定 | 10.00秒 | 1 | 1 | 0 | 0.42秒 | 合格 |");
		expect(lines[3]).toBe("| 通知 | 5.00秒 | 1 | 0 | 1 | 計測なし | — |");
		expect(lines[4]).toContain("不合格");
	});
});
