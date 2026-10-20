/**
 * 提案の回答期限と提案可否の純関数(F4a設計 §3.4・docs/01 §8)。
 * 時刻は引数で受け取り、Clockの呼び出しは呼び出し側が担う(docs/04 §4)。
 */

import { type IntentForm, LATCH } from "@latch/shared";
import type { IntentRow } from "../pipeline/consumer";

/** 機会の対象時刻=全メンバーのstarts_atの最大値(重なりの開始)。starts_at欠落は不変条件違反 */
export const occasionTargetAt = (members: IntentRow[]): Date => {
	let target: Date | null = null;
	for (const m of members) {
		if (m.startsAt === null) {
			throw new Error("occasion intent without starts_at");
		}
		if (target === null || m.startsAt.getTime() > target.getTime()) {
			target = m.startsAt;
		}
	}
	if (target === null) throw new Error("occasion target requires members");
	return target;
};

/** 参加Intentのexpires_atの最小値(active化済みなら必ず非null) */
export const minExpiry = (members: IntentRow[]): Date => {
	let min: Date | null = null;
	for (const m of members) {
		if (m.expiresAt === null) {
			throw new Error("active intent without expires_at");
		}
		if (min === null || m.expiresAt.getTime() < min.getTime()) {
			min = m.expiresAt;
		}
	}
	if (min === null) throw new Error("min expiry requires members");
	return min;
};

/**
 * 回答期限。
 * 機会 = min(max(提示+15分, min(提示+2時間, 対象時刻-60分)), Intent期限最小)
 * つながり = min(提示+24時間, Intent期限最小)
 */
export const responseDeadline = (
	form: IntentForm,
	presentedAt: Date,
	targetAt: Date | null,
	minIntentExpiry: Date,
): Date => {
	const p = presentedAt.getTime();
	let deadline: number;
	if (form === "occasion") {
		if (targetAt === null) {
			throw new Error("occasion deadline requires targetAt");
		}
		deadline = Math.max(
			p + LATCH.OCCASION_DEADLINE_MIN_MS,
			Math.min(
				p + LATCH.OCCASION_DEADLINE_MAX_MS,
				targetAt.getTime() - LATCH.OCCASION_DEADLINE_BEFORE_START_MS,
			),
		);
	} else {
		deadline = p + LATCH.CONNECTION_DEADLINE_MS;
	}
	return new Date(Math.min(deadline, minIntentExpiry.getTime()));
};

/** 機会で対象時刻まで75分未満なら提案しない(ちょうど75分は提案可) */
export const isTooLate = (targetAt: Date, now: Date): boolean =>
	targetAt.getTime() - now.getTime() < LATCH.OCCASION_MIN_LEAD_MS;
