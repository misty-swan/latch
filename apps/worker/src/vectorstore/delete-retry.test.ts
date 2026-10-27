/**
 * 意思の削除と退会のベクトルの削除のやり直し(LAT-126)の単体試験。
 * 待ちは記録だけする偽物のsleepを渡し、実時間では待たない
 */
import { PIPELINE } from "@latch/shared";
import { describe, expect, it, vi } from "vitest";
import type { Sleep } from "../clock/clock";
import {
	deleteVectorsWithRetry,
	isVectorDeleteRateLimited,
} from "./delete-retry";
import type { VectorStore } from "./types";

const rateLimited = () =>
	new Error("VECTOR_DELETE_ERROR (code = 40041): Too Many Requests");

/** deleteByIdsだけを持つ偽物(他の操作は呼ばれない) */
const storeWith = (deleteByIds: VectorStore["deleteByIds"]): VectorStore => ({
	upsert: vi.fn(),
	query: vi.fn(),
	getByIds: vi.fn(),
	deleteByIds,
});

/** 待ちの長さを記録するだけのsleep */
const recordingSleep = (): { sleep: Sleep; waits: number[] } => {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms) => {
			waits.push(ms);
		},
	};
};

describe("deleteVectorsWithRetry", () => {
	it("既定の待ちは0.5秒・1秒の2回(最大の合計1.5秒)", () => {
		expect(PIPELINE.VECTOR_DELETE_RETRY_DELAYS_MS).toEqual([500, 1_000]);
	});

	it("1回目で成功したら待たない", async () => {
		const deleteByIds = vi.fn(async () => {});
		const { sleep, waits } = recordingSleep();
		await deleteVectorsWithRetry(
			storeWith(deleteByIds),
			["a"],
			sleep,
			[500, 1_000],
		);
		expect(deleteByIds).toHaveBeenCalledTimes(1);
		expect(deleteByIds).toHaveBeenCalledWith(["a"]);
		expect(waits).toEqual([]);
	});

	it("上限に当たったら0.5秒待ってやり直し、成功すれば例外を出さない", async () => {
		const deleteByIds = vi
			.fn<VectorStore["deleteByIds"]>()
			.mockRejectedValueOnce(rateLimited())
			.mockResolvedValueOnce(undefined);
		const { sleep, waits } = recordingSleep();
		await deleteVectorsWithRetry(
			storeWith(deleteByIds),
			["a"],
			sleep,
			[500, 1_000],
		);
		expect(deleteByIds).toHaveBeenCalledTimes(2);
		expect(waits).toEqual([500]);
	});

	it("全部失敗したら0.5秒・1秒の後に最後の例外を投げる(計3回)", async () => {
		const last = rateLimited();
		const deleteByIds = vi
			.fn<VectorStore["deleteByIds"]>()
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
			.mockRejectedValueOnce(last);
		const { sleep, waits } = recordingSleep();
		await expect(
			deleteVectorsWithRetry(
				storeWith(deleteByIds),
				["a"],
				sleep,
				[500, 1_000],
			),
		).rejects.toBe(last);
		expect(deleteByIds).toHaveBeenCalledTimes(3);
		expect(waits).toEqual([500, 1_000]);
	});
});

describe("isVectorDeleteRateLimited", () => {
	it("VECTOR_DELETE_40041だけを上限として扱う", () => {
		expect(isVectorDeleteRateLimited(rateLimited())).toBe(true);
		// causeに包まれていても分類する(errorCodeOfと同じ)
		expect(
			isVectorDeleteRateLimited(new Error("wrap", { cause: rateLimited() })),
		).toBe(true);
		expect(
			isVectorDeleteRateLimited(
				new Error("VECTOR_DELETE_ERROR (code = 40007): other"),
			),
		).toBe(false);
		expect(isVectorDeleteRateLimited(new Error("vectorize down"))).toBe(false);
	});
});
