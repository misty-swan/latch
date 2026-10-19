import {
	EMBEDDING_MODEL_REAL,
	EMBEDDING_MODEL_STUB,
	PIPELINE,
} from "@latch/shared";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createEmbedder, resolveEmbeddingMode } from "./embedding";
import { stubEmbedding } from "./stub/embedding";

describe("resolveEmbeddingMode(07 §2: 既定stub・不正値もstub)", () => {
	it("未設定はstub", () => {
		expect(resolveEmbeddingMode(undefined)).toBe("stub");
	});

	it("stubはstub", () => {
		expect(resolveEmbeddingMode("stub")).toBe("stub");
	});

	it("realはreal", () => {
		expect(resolveEmbeddingMode("real")).toBe("real");
	});

	it("不正値(前後空白付き)はstubに倒す", () => {
		expect(resolveEmbeddingMode(" nonsense")).toBe("stub");
	});

	it("空文字はstub", () => {
		expect(resolveEmbeddingMode("")).toBe("stub");
	});
});

describe("createEmbedder stub(07 §2(c))", () => {
	it("modelIdはEMBEDDING_MODEL_STUB", () => {
		const embedder = createEmbedder({
			LATCH_EMBEDDING_MODE: "stub",
		} as unknown as Env);
		expect(embedder.modelId).toBe(EMBEDDING_MODEL_STUB);
	});

	it("embedはstubEmbeddingと同じ決定的ベクトル(1024次元)を返す", async () => {
		const embedder = createEmbedder({
			LATCH_EMBEDDING_MODE: "stub",
		} as unknown as Env);
		const vector = await embedder.embed("日曜17時にカレー会");
		const expected = await stubEmbedding("日曜17時にカレー会");
		expect(vector).toEqual(expected);
		expect(vector).toHaveLength(1024);
	});

	it("LATCH_EMBEDDING_MODE未設定はstubに倒す", () => {
		const embedder = createEmbedder({} as unknown as Env);
		expect(embedder.modelId).toBe(EMBEDDING_MODEL_STUB);
	});
});

describe("createEmbedder real(07 §1・§4: Workers AI bge-m3)", () => {
	it("AIバインディング不在は構築時にthrowする", () => {
		expect(() =>
			createEmbedder({ LATCH_EMBEDDING_MODE: "real" } as unknown as Env),
		).toThrow("AI_BINDING_MISSING");
	});

	it("AI.run(bge-m3・{text:[input]})の応答data[0]をベクトルとして返す・modelIdはEMBEDDING_MODEL_REAL", async () => {
		// Aiの代役(型なしオブジェクトのキャスト)。docs/07 §4の応答形状を模す
		const calls: Array<{ model: string; inputs: { text: string[] } }> = [];
		const fakeAi = {
			run: async (model: string, inputs: { text: string[] }) => {
				calls.push({ model, inputs });
				return { shape: [1, 2], data: [[0.1, 0.2]] };
			},
		};
		const embedder = createEmbedder({
			LATCH_EMBEDDING_MODE: "real",
			AI: fakeAi,
		} as unknown as Env);

		const vector = await embedder.embed("日曜17時にカレー会");

		expect(vector).toEqual([0.1, 0.2]);
		expect(embedder.modelId).toBe(EMBEDDING_MODEL_REAL);
		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe("@cf/baai/bge-m3");
		expect(calls[0].inputs).toEqual({ text: ["日曜17時にカレー会"] });
	});

	it("timeout 5秒・再試行なし(runが永続pendingなら5秒後にreject)", async () => {
		vi.useFakeTimers();
		try {
			const fakeAi = { run: () => new Promise(() => {}) };
			const embedder = createEmbedder({
				LATCH_EMBEDDING_MODE: "real",
				AI: fakeAi,
			} as unknown as Env);

			const pending = embedder.embed("永続pending");
			// rejectsの検査を先に設定し、未処理の拒否を避ける
			const assertion = expect(pending).rejects.toThrow("EMBEDDING_TIMEOUT");
			await vi.advanceTimersByTimeAsync(PIPELINE.EMBEDDING_TIMEOUT_MS);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("応答にdata配列がない形状はembedding失敗としてrejectする", async () => {
		const fakeAi = { run: async () => ({ request_id: "req-1" }) };
		const embedder = createEmbedder({
			LATCH_EMBEDDING_MODE: "real",
			AI: fakeAi,
		} as unknown as Env);

		await expect(embedder.embed("形状不正")).rejects.toThrow(
			"EMBEDDING_UNEXPECTED_RESPONSE",
		);
	});
});
