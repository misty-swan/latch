/** オフライン判定と固定文言(F8a設計 §1.3・§2)の試験 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { isOfflineError, OFFLINE_MESSAGES } from "./errors";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isOfflineError", () => {
	it("fetchの通信失敗(TypeError)はオフライン扱い", () => {
		expect(isOfflineError(new TypeError("Failed to fetch"))).toBe(true);
	});

	it("ApiError(サーバーが答えた失敗)はオフラインではない", () => {
		expect(isOfflineError(new ApiError("NOT_FOUND", "x"))).toBe(false);
	});

	it("navigator.onLineがfalseならどの失敗でもオフライン扱い", () => {
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
		expect(isOfflineError(new Error("x"))).toBe(true);
	});

	it("ApiErrorはonLineがfalseでもfalse", () => {
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
		expect(isOfflineError(new ApiError("NOT_FOUND", "x"))).toBe(false);
	});
});

describe("OFFLINE_MESSAGES", () => {
	it("設計書の固定文言", () => {
		expect(OFFLINE_MESSAGES).toEqual({
			parse: "オフラインのため、いまは読み解けません。",
			send: "オフラインのため、送れませんでした。",
			generic: "オフラインのため、いまは操作できません。",
		});
	});
});
