/**
 * レート制限(429 RATE_LIMITED・docs/05 §3.1)の案内文。理由(details.reason)ごとに出し分け、
 * 各画面の既存のエラー表示の場所に出す(2026-10-26オーナー決定・05 §3.1)。
 * 未知の理由は60req/分の文に倒す
 */

import { ApiError } from "./client";

export const RATE_LIMIT_MESSAGES = {
	requests_per_minute:
		"操作が続いたため、少し時間をおいてください。1分ほどでまたお使いいただけます。",
	intent_creates_per_day:
		"今日預けられる意思の数の上限に達しました。明日もう一度お試しください。",
	intent_updates_per_hour:
		"意思の書き直しは1時間に6回までです。時間をおいて、もう一度お試しください。",
} as const;

/** 429のときは理由ごとの案内文を、それ以外はnullを返す */
export const rateLimitMessage = (error: unknown): string | null => {
	if (!(error instanceof ApiError) || error.code !== "RATE_LIMITED") {
		return null;
	}
	const reason = error.details.reason;
	return typeof reason === "string" && reason in RATE_LIMIT_MESSAGES
		? RATE_LIMIT_MESSAGES[reason as keyof typeof RATE_LIMIT_MESSAGES]
		: RATE_LIMIT_MESSAGES.requests_per_minute;
};
