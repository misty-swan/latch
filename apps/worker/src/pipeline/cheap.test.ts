/**
 * Layer 3 Cheap Judge(docs/06 §3)の試験。
 *
 * 合成スコア(0.7×正規化類似度+0.3×ルール点・3要素等分)の純関数の単体試験。
 * 重み・clamp・文字2-gram(stride 1)・長さ2未満の代替・地理の中立値0.5・
 * 決定性と0..1範囲を、手計算の期待値で直接検証する
 */
import { describe, expect, it } from "vitest";
import { cheapJudgeScore } from "./cheap";

/** 全要素が一致する基準入力(類似度1・同一topic・participants 2〜4・同地点) */
const baseInput = {
	similarity: 1,
	topicA: "学習仲間",
	topicB: "学習仲間",
	participantsA: { min: 2, max: 4 },
	participantsB: { min: 2, max: 4 },
	geoDistanceM: 0,
};

describe("cheapJudgeScore", () => {
	it("類似度1・全一致で最高得点(0.7+0.3×1)", () => {
		// 0.7×1 + 0.3×(1+1+1)/3 = 1
		expect(cheapJudgeScore(baseInput)).toBeCloseTo(1);
	});

	it("重み0.7: ルール点0なら0.7×類似度そのもの", () => {
		// topic不一致(0)・participants全離散(0)・距離100kmで地理0 → ruleScore=0
		const score = cheapJudgeScore({
			...baseInput,
			similarity: 0.5,
			topicA: "あいう",
			topicB: "かきく",
			participantsA: { min: 2, max: 2 },
			participantsB: { min: 4, max: 4 },
			geoDistanceM: 100_000,
		});
		expect(score).toBeCloseTo(0.35); // 0.7×0.5
	});

	it("重み0.3: 類似度0ならルール点分のみ", () => {
		// 0.7×0 + 0.3×1 = 0.3
		expect(cheapJudgeScore({ ...baseInput, similarity: 0 })).toBeCloseTo(0.3);
	});

	it("類似度はclampされる(負は0・1超は1と同一値)", () => {
		expect(cheapJudgeScore({ ...baseInput, similarity: -0.5 })).toBe(
			cheapJudgeScore({ ...baseInput, similarity: 0 }),
		);
		expect(cheapJudgeScore({ ...baseInput, similarity: 1.5 })).toBe(
			cheapJudgeScore({ ...baseInput, similarity: 1 }),
		);
	});

	it("トピック不一致はruleScoreを減らす(2-gramが交差しない)", () => {
		// 一致: (1+1+0.5)/3 → 0.7+0.3×5/6=0.95 / 不一致: (0+1+0.5)/3 → 0.85
		const same = cheapJudgeScore({
			...baseInput,
			topicA: "あいう",
			topicB: "あいう",
			geoDistanceM: null,
		});
		const diff = cheapJudgeScore({
			...baseInput,
			topicA: "あいう",
			topicB: "かきく",
			geoDistanceM: null,
		});
		expect(same).toBeCloseTo(0.95);
		expect(diff).toBeCloseTo(0.85);
		expect(diff).toBeLessThan(same);
	});

	it("文字2-gramは文字単位・stride 1で部分一致が中間値", () => {
		// 「日本語学習」={日本,本語,語学,学習}・「日本語」={日本,本語} → 2/4=0.5
		// (0.5+1+0.5)/3=2/3 → 0.7+0.3×2/3=0.9
		expect(
			cheapJudgeScore({
				...baseInput,
				topicA: "日本語学習",
				topicB: "日本語",
				geoDistanceM: null,
			}),
		).toBeCloseTo(0.9);
	});

	it("長さ2未満は文字集合のJaccardに代替", () => {
		// 「あ」vs「あ」=1(全一致ケースと同じ値)
		expect(cheapJudgeScore({ ...baseInput, topicA: "あ", topicB: "あ" })).toBe(
			cheapJudgeScore(baseInput),
		);
		// 「あ」vs「い」=0(不一致ケースと同じ値)
		expect(
			cheapJudgeScore({
				...baseInput,
				topicA: "あ",
				topicB: "い",
				geoDistanceM: null,
			}),
		).toBe(
			cheapJudgeScore({
				...baseInput,
				topicA: "あいう",
				topicB: "かきく",
				geoDistanceM: null,
			}),
		);
	});

	it("双方空文字列のtopicは同一扱いで1(0除算しない)", () => {
		const score = cheapJudgeScore({ ...baseInput, topicA: "", topicB: "" });
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeCloseTo(1);
	});

	it("participants: 全離散は0・部分重なりは共通幅に比例", () => {
		// 全離散{2,2}×{4,4}: 幅max(0, 2−4+1)=0 → (1+0+1)/3=2/3 → 0.9
		const disjoint = cheapJudgeScore({
			...baseInput,
			participantsA: { min: 2, max: 2 },
			participantsB: { min: 4, max: 4 },
		});
		expect(disjoint).toBeCloseTo(0.9);
		// 部分{2,3}×{3,4}: 幅3−3+1=1 → 1/3 → (1+1/3+1)/3=7/9
		const partial = cheapJudgeScore({
			...baseInput,
			participantsA: { min: 2, max: 3 },
			participantsB: { min: 3, max: 4 },
		});
		expect(partial).toBeCloseTo(0.7 + 0.3 * (7 / 9));
		expect(disjoint).toBeLessThan(partial);
		expect(partial).toBeLessThan(cheapJudgeScore(baseInput));
	});

	it("地理: 距離0で1・100kmちょうどで0・100km超も0", () => {
		// 類似度0で地理だけ変える。距離0 → (1+1+1)/3 → 0.3
		expect(
			cheapJudgeScore({ ...baseInput, similarity: 0, geoDistanceM: 0 }),
		).toBeCloseTo(0.3);
		// 100km → 1−min(1, 1)=0 → (1+1+0)/3 → 0.2
		expect(
			cheapJudgeScore({ ...baseInput, similarity: 0, geoDistanceM: 100_000 }),
		).toBeCloseTo(0.2);
		// 150km超 → 同じく0
		expect(
			cheapJudgeScore({ ...baseInput, similarity: 0, geoDistanceM: 150_000 }),
		).toBeCloseTo(0.2);
	});

	it("地理: 50kmは0.5で未添付(null)の中立値0.5と同一", () => {
		// 1 − min(1, 50000/100000) = 0.5 = 未添付の中立値
		const half = cheapJudgeScore({ ...baseInput, geoDistanceM: 50_000 });
		const neutral = cheapJudgeScore({ ...baseInput, geoDistanceM: null });
		expect(half).toBe(neutral);
		// (1+1+0.5)/3 → 0.95
		expect(neutral).toBeCloseTo(0.95);
	});

	it("同一入力に対し決定的(常に同一値)", () => {
		expect(cheapJudgeScore(baseInput)).toBe(cheapJudgeScore(baseInput));
		expect(
			cheapJudgeScore({ ...baseInput, similarity: 0.42, geoDistanceM: null }),
		).toBe(
			cheapJudgeScore({ ...baseInput, similarity: 0.42, geoDistanceM: null }),
		);
	});

	it("任意の入力でスコアは0..1の範囲内", () => {
		const inputs = [
			baseInput,
			{ ...baseInput, similarity: -3 },
			{ ...baseInput, similarity: 7 },
			{ ...baseInput, similarity: 0.37 },
			{ ...baseInput, topicA: "", topicB: "" },
			{ ...baseInput, topicA: "カフェ", topicB: "ランニング" },
			{
				...baseInput,
				participantsA: { min: 2, max: 2 },
				participantsB: { min: 4, max: 4 },
			},
			{ ...baseInput, geoDistanceM: null },
			{ ...baseInput, geoDistanceM: 999_999 },
			{
				...baseInput,
				similarity: 0.5,
				topicA: "映画",
				topicB: "映画",
				participantsA: { min: 3, max: 3 },
				geoDistanceM: 12_345,
			},
		];
		for (const input of inputs) {
			const score = cheapJudgeScore(input);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});
