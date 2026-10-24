import { describe, expect, it } from "vitest";
import { cosine, median, separation } from "./separation";

describe("separation", () => {
	it("完全に分かれていればaucは1・差は中央値の差", () => {
		const r = separation([0.8, 0.9, 0.7], [0.1, 0.2, 0.3]);
		expect(r.auc).toBe(1);
		expect(r.medianGap).toBeCloseTo(0.6);
	});
	it("同じ分布ならaucは0.5・差は0", () => {
		const r = separation([0.5, 0.6], [0.5, 0.6]);
		expect(r.auc).toBe(0.5);
		expect(r.medianGap).toBe(0);
	});
	it("逆に分かれていればaucは0", () => {
		expect(separation([0.1], [0.9]).auc).toBe(0);
	});
	it("片方が空ならNaN", () => {
		expect(separation([], [0.1]).auc).toBeNaN();
	});
});

describe("median・cosine", () => {
	it("偶数個は中央2つの平均", () => {
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
	it("cosine", () => {
		expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
	});
});
