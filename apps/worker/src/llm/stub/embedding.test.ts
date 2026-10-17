import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, stubEmbedding } from "./embedding";

describe("stubEmbedding(07 §2(c): SHA-256由来の決定的擬似ベクトル)", () => {
	it("1024次元を返す", async () => {
		const vector = await stubEmbedding("x");
		expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(EMBEDDING_DIMENSIONS).toBe(1024);
	});

	it("L2正規化済みでノルムが1", async () => {
		const vector = await stubEmbedding("x");
		const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
		expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
	});

	it("同一入力は同一配列(決定的)", async () => {
		const first = await stubEmbedding("決定性チェック");
		const second = await stubEmbedding("決定性チェック");
		expect(second).toEqual(first);
	});

	it("異なる入力は異なる配列", async () => {
		const a = await stubEmbedding("a");
		const b = await stubEmbedding("b");
		expect(a.some((x, i) => x !== b[i])).toBe(true);
	});
});
