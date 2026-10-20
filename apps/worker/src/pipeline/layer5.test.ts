/**
 * Layer 5の純関数(latchScore・pickProposals)の単体試験(docs/06 §6)。
 */
import { describe, expect, it } from "vitest";
import type { JevAxes } from "../llm/types";
import { type L5Item, latchScore, pickProposals } from "./layer5";

const axes = (a: number, b: number): JevAxes => ({
	would_a_accept_b: a,
	would_b_accept_a: b,
	purpose_fit: 0.1,
	mood_fit: 0.1,
	timing_fit: 0.1,
	social_fit: 0.1,
	latent_yes: 0.1,
});

const item = (rowId: string, pair: string, score: number): L5Item => ({
	rowId,
	pair,
	score,
});

describe("latchScore", () => {
	it("h=1のとき双方向の受容確率の小さい方を返す", () => {
		expect(latchScore(axes(0.9, 0.7), 1)).toBe(0.7);
		expect(latchScore(axes(0.7, 0.9), 1)).toBe(0.7);
	});

	it("h=0のとき0になる", () => {
		expect(latchScore(axes(0.9, 0.7), 0)).toBe(0);
	});
});

describe("pickProposals", () => {
	it("閾値0.6ちょうどは除外し0.61は残す", () => {
		const out = pickProposals([item("r1", "p1", 0.6), item("r2", "p2", 0.61)]);
		expect(out.map((i) => i.rowId)).toEqual(["r2"]);
	});

	it("同じpairは最高score1件だけ残す", () => {
		const out = pickProposals([item("r1", "p", 0.8), item("r2", "p", 0.9)]);
		expect(out.map((i) => i.rowId)).toEqual(["r2"]);
	});

	it("同点のpairはrowId昇順で先の1件を残す", () => {
		const out = pickProposals([item("r2", "p", 0.8), item("r1", "p", 0.8)]);
		expect(out.map((i) => i.rowId)).toEqual(["r1"]);
	});

	it("出力はscore降順(同点はrowId昇順)", () => {
		const out = pickProposals([
			item("r3", "p3", 0.7),
			item("r2", "p2", 0.9),
			item("r1", "p1", 0.7),
		]);
		expect(out.map((i) => i.rowId)).toEqual(["r2", "r1", "r3"]);
	});

	it("空入力は空配列", () => {
		expect(pickProposals([])).toEqual([]);
	});
});
