/**
 * 提案の中身(latches.proposal)の組み立て(F4a設計 §3.6)。純関数。
 */

import type { LatchProposal } from "@latch/shared";
import type { IntentRow } from "../pipeline/consumer";

/** topic・地域の基準Intent=先に預けられた側(created_atの早い方・同値はid昇順) */
export const baseIntentOf = (a: IntentRow, b: IntentRow): IntentRow => {
	const d = a.createdAt.getTime() - b.createdAt.getTime();
	if (d !== 0) return d < 0 ? a : b;
	return a.id <= b.id ? a : b;
};

/** 機会Intentの終端=ends_at ?? expires_at */
const endOf = (i: IntentRow): Date => {
	const end = i.endsAt ?? i.expiresAt;
	if (end === null) {
		throw new Error("occasion intent without end time");
	}
	return end;
};

export const buildProposal = (
	a: IntentRow,
	b: IntentRow,
	regionName: string | null,
): LatchProposal => {
	const base = baseIntentOf(a, b);
	const form = base.form;
	if (form === null) throw new Error("proposal intent without form");

	let timeWindow: LatchProposal["time_window"] = null;
	let budget: LatchProposal["budget"] = null;
	if (form === "occasion") {
		if (a.startsAt === null || b.startsAt === null) {
			throw new Error("occasion intent without starts_at");
		}
		const start = Math.max(a.startsAt.getTime(), b.startsAt.getTime());
		const end = Math.min(endOf(a).getTime(), endOf(b).getTime());
		timeWindow = {
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
		};
		if (
			a.budgetMin !== null &&
			a.budgetMax !== null &&
			b.budgetMin !== null &&
			b.budgetMax !== null
		) {
			const min = Math.max(a.budgetMin, b.budgetMin);
			const max = Math.min(a.budgetMax, b.budgetMax);
			// 共通部分が空なら予算は開示しない
			if (min <= max) budget = { min, max };
		}
	}

	const pMin = Math.max(a.participantsMin, b.participantsMin);
	const pMax = Math.min(a.participantsMax, b.participantsMax);
	// Layer 1で区間の重なりは保証済み。防御として空なら基準Intentの値を使う
	const participants =
		pMin <= pMax
			? { min: pMin, max: pMax }
			: { min: base.participantsMin, max: base.participantsMax };

	return {
		form,
		topic: base.topic,
		time_window: timeWindow,
		region_name: regionName,
		participants,
		budget,
	};
};
