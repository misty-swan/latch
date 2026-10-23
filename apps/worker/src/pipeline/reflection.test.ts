/**
 * 反映確認の遅延の計算(nextReflectionDelaySeconds)の単体試験(不具合の修正工程の設計 §2.3)。
 * 確認の時点は作成から2・6・14・30・60秒、以後30秒ごと。8分で打ち切る(#21)
 */
import { describe, expect, it } from "vitest";
import { nextReflectionDelaySeconds } from "./reflection";

describe("nextReflectionDelaySeconds", () => {
	it.each([
		[0, 2],
		[2_000, 4],
		[6_000, 8],
		[14_000, 16],
		[30_000, 30],
		[45_000, 15],
		[60_000, 30],
		[299_000, 1],
		[300_000, 30],
		[479_000, 1],
	])("経過%iミリ秒なら次の確認まで%i秒", (elapsedMs, expected) => {
		expect(nextReflectionDelaySeconds(elapsedMs)).toBe(expected);
	});

	it("端数は切り上げ・最小1秒", () => {
		expect(nextReflectionDelaySeconds(1_500)).toBe(1);
		expect(nextReflectionDelaySeconds(1_999)).toBe(1);
		expect(nextReflectionDelaySeconds(2_500)).toBe(4);
	});

	it("作成から8分以上ならnull(打ち切り)", () => {
		expect(nextReflectionDelaySeconds(480_000)).toBeNull();
		expect(nextReflectionDelaySeconds(500_000)).toBeNull();
	});
});
