import { describe, expect, it } from "vitest";
import {
	p95,
	quantile,
	renderReferenceTable,
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
	it("nullは欠けとして数え、欠けがあれば目標以内でも判定を保留(null)にする", () => {
		expect(summarize("初期判定", 10000, [1000, null, 3000])).toEqual({
			name: "初期判定",
			targetMs: 10000,
			total: 3,
			measured: 2,
			missing: 1,
			p95Ms: 3000,
			pass: null,
		});
	});
	it("欠けが無く目標以内なら合格", () => {
		expect(summarize("x", 2000, [1000, 2000]).pass).toBe(true);
	});
	it("目標を超えると不合格", () => {
		expect(summarize("x", 2000, [1000, 3000]).pass).toBe(false);
	});
	it("欠けがあっても計測したp95が目標を超えれば不合格", () => {
		expect(summarize("x", 2000, [3000, null, null]).pass).toBe(false);
	});
	it("計測が0件ならp95Msもpassもnull", () => {
		const s = summarize("通知", 5000, [null]);
		expect(s.measured).toBe(0);
		expect(s.p95Ms).toBeNull();
		expect(s.pass).toBeNull();
	});
});

describe("renderTable", () => {
	it("nullは計測なしと—、欠けありの保留は—(欠けあり)、ミリ秒は秒へ", () => {
		const out = renderTable([
			summarize("初期判定", 10000, [420]),
			summarize("通知", 5000, [null]),
			summarize("遅い", 100, [420]),
			summarize("欠け", 10000, [420, null]),
			summarize("欠けて遅い", 100, [420, null]),
		]);
		const lines = out.split("\n");
		expect(lines[0]).toBe("| 項目 | 目標 | 対象 | 計測 | 欠け | p95 | 判定 |");
		expect(lines[2]).toBe("| 初期判定 | 10.00秒 | 1 | 1 | 0 | 0.42秒 | 合格 |");
		expect(lines[3]).toBe("| 通知 | 5.00秒 | 1 | 0 | 1 | 計測なし | — |");
		expect(lines[4]).toContain("不合格");
		expect(lines[5]).toBe(
			"| 欠け | 10.00秒 | 2 | 1 | 1 | 0.42秒 | —(欠けあり) |",
		);
		expect(lines[6]).toContain("| 不合格 |");
	});
});

describe("quantile", () => {
	it("p50は最近順位法、p95と同じ計算", () => {
		expect(quantile([4, 1, 3, 2], 0.5)).toBe(2);
		expect(quantile(range(100), 0.95)).toBe(p95(range(100)));
		expect(quantile([], 0.5)).toBeNull();
		expect(quantile([7], 0)).toBe(7);
	});
});

describe("renderReferenceTable", () => {
	it("件数・欠け・p50・p95・最大を、項目ごとの行で出す(合否なし)", () => {
		const out = renderReferenceTable([
			{ name: "A", durations: [1000, 3000, null] },
			{ name: "B", durations: [] },
		]).split("\n");
		expect(out[0]).toBe("| 項目(参考) | 件数 | 欠け | p50 | p95 | 最大 |");
		expect(out[2]).toBe("| A | 3 | 1 | 1.00秒 | 3.00秒 | 3.00秒 |");
		expect(out[3]).toBe("| B | 0 | 0 | 計測なし | 計測なし | 計測なし |");
		expect(out).toHaveLength(4);
	});
	it("すべて欠けなら計測なし(NaNを出さない)", () => {
		const out = renderReferenceTable([{ name: "C", durations: [null, null] }]);
		expect(out).toContain("| C | 2 | 2 | 計測なし | 計測なし | 計測なし |");
		expect(out).not.toContain("NaN");
	});
});
