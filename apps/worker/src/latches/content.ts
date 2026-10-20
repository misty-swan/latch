/**
 * 提案の中身(latches.proposal)の組み立て(F4a設計 §3.6)。純関数。
 */

import type { LatchProposal } from "@latch/shared";
import type { IntentRow } from "../pipeline/consumer";

/** topic・地域の基準Intent=最も先に預けられた者(created_atの最小・同値はid昇順) */
export const baseIntentOf = (members: IntentRow[]): IntentRow => {
	const [first, ...rest] = members;
	if (first === undefined) throw new Error("base intent requires members");
	let base = first;
	for (const m of rest) {
		const d = m.createdAt.getTime() - base.createdAt.getTime();
		if (d < 0 || (d === 0 && m.id < base.id)) base = m;
	}
	return base;
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
	members: IntentRow[],
	regionName: string | null,
): LatchProposal => {
	const base = baseIntentOf(members);
	const form = base.form;
	if (form === null) throw new Error("proposal intent without form");

	let timeWindow: LatchProposal["time_window"] = null;
	let budget: LatchProposal["budget"] = null;
	if (form === "occasion") {
		const starts = members.map((m) => {
			if (m.startsAt === null) {
				throw new Error("occasion intent without starts_at");
			}
			return m.startsAt.getTime();
		});
		const start = Math.max(...starts);
		const end = Math.min(...members.map((m) => endOf(m).getTime()));
		timeWindow = {
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
		};
		// 全員が予算を持ち、共通部分が空でないときだけ開示する
		if (members.every((m) => m.budgetMin !== null && m.budgetMax !== null)) {
			const min = Math.max(...members.map((m) => m.budgetMin ?? 0));
			const max = Math.min(
				...members.map((m) => m.budgetMax ?? Number.POSITIVE_INFINITY),
			);
			if (min <= max) budget = { min, max };
		}
	}

	const pMin = Math.max(...members.map((m) => m.participantsMin));
	const pMax = Math.min(...members.map((m) => m.participantsMax));
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
