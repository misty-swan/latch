/**
 * レート制限(429 RATE_LIMITED)の案内文の単体試験(05 §3.1・2026-10-26オーナー決定)。
 * 理由ごとの出し分け・未知の理由の倒し先・429以外はnull
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { RATE_LIMIT_MESSAGES, rateLimitMessage } from "./rate-limit";

const limited = (reason?: unknown) =>
	new ApiError(
		"RATE_LIMITED",
		"操作の回数が上限に達しました",
		reason === undefined ? {} : { reason },
	);

describe("rateLimitMessage", () => {
	it("理由ごとの案内文を返す", () => {
		expect(rateLimitMessage(limited("requests_per_minute"))).toBe(
			"操作が続いたため、少し時間をおいてください。1分ほどでまたお使いいただけます。",
		);
		expect(rateLimitMessage(limited("intent_creates_per_day"))).toBe(
			"今日預けられる意思の数の上限に達しました。明日もう一度お試しください。",
		);
		expect(rateLimitMessage(limited("intent_updates_per_hour"))).toBe(
			"意思の書き直しは1時間に6回までです。時間をおいて、もう一度お試しください。",
		);
	});

	it("理由が無い・未知のときは60req/分の文に倒す", () => {
		expect(rateLimitMessage(limited())).toBe(
			RATE_LIMIT_MESSAGES.requests_per_minute,
		);
		expect(rateLimitMessage(limited("something_else"))).toBe(
			RATE_LIMIT_MESSAGES.requests_per_minute,
		);
		expect(rateLimitMessage(limited(42))).toBe(
			RATE_LIMIT_MESSAGES.requests_per_minute,
		);
	});

	it("429以外のエラー・ApiErrorでない値はnull", () => {
		expect(
			rateLimitMessage(new ApiError("VALIDATION_FAILED", "x", {})),
		).toBeNull();
		expect(rateLimitMessage(new TypeError("Failed to fetch"))).toBeNull();
		expect(rateLimitMessage(null)).toBeNull();
	});
});
