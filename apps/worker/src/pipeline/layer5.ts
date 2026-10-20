/**
 * Layer 5 Scoring(docs/06 §6)。
 *
 * - latchScore: LATCH Score = H × min(would_a_accept_b, would_b_accept_a) × C
 * - pickProposals: 閾値超過のみを残し、ユーザーペアごとに最大1件へ絞る
 * - recheckHard: 提案化の直前に起点Intentを読み直し、Hard Constraint(Layer 1)を
 *   D1の現行値で再検証する(docs/06 §3の二重化)
 * match_candidates.latch_scoreへの保存は呼び出し側が行う
 */
import { LATCH } from "@latch/shared";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { intents } from "../db/schema";
import type { JevAxes } from "../llm/types";
import { fetchL1Data, layer1Judge, pairKey } from "./layer1";

/** Layer 5の入力1件。pairはpairKey(userA, userB) */
export interface L5Item {
	rowId: string;
	pair: string;
	score: number;
}

/** LATCH Score(docs/06 §6)。hはHard Constraint通過(1)か否(0) */
export const latchScore = (axes: JevAxes, h: 0 | 1): number =>
	h *
	Math.min(axes.would_a_accept_b, axes.would_b_accept_a) *
	LATCH.CALIBRATION_C;

/** score降順・同点はrowId昇順の比較 */
const byScoreThenRowId = (a: L5Item, b: L5Item): number =>
	b.score - a.score || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);

/**
 * 提案対象の選択(docs/06 §6)。score > 閾値のみ・pairごとに最大1件
 * (最高score・同点はrowId昇順)・出力はscore降順(同点はrowId昇順)
 */
export const pickProposals = (items: L5Item[]): L5Item[] => {
	const best = new Map<string, L5Item>();
	for (const it of [...items].sort(byScoreThenRowId)) {
		if (it.score > LATCH.THRESHOLD && !best.has(it.pair)) {
			best.set(it.pair, it);
		}
	}
	return [...best.values()].sort(byScoreThenRowId);
};

/**
 * Hard Constraintの再検証(docs/06 §6)。起点Intentを読み直し、active以外
 * (または不在)なら空集合。それ以外はLayer 1を再実行して合格したotherIdの集合を返す
 */
export const recheckHard = async (
	db: DrizzleD1Database,
	originId: string,
	otherIds: string[],
	now: Date,
): Promise<Set<string>> => {
	const [origin] = await db
		.select()
		.from(intents)
		.where(eq(intents.id, originId))
		.limit(1);
	if (origin === undefined || origin.status !== "active") {
		return new Set();
	}
	const l1 = await fetchL1Data(db, origin.userId, otherIds);
	const passed = new Set<string>();
	for (const id of otherIds) {
		const candidate = l1.intents[id] ?? null;
		const pair =
			candidate === null ? null : pairKey(origin.userId, candidate.userId);
		const judgement = layer1Judge(
			origin,
			candidate,
			l1.birthDates,
			pair !== null && l1.blockedPairs.has(pair),
			pair !== null && l1.historyPairs.has(pair),
			now,
		);
		if (judgement.pass) {
			passed.add(id);
		}
	}
	return passed;
};
