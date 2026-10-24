/**
 * Layer 5 Scoring(docs/06 §6)。
 *
 * - latchScore: LATCH Score = H × min(would_a_accept_b, would_b_accept_a) × C
 * - pickProposals: 閾値超過のみを残し、ユーザーペアごとに最大1件へ絞る
 * - recheckHard: 提案化の直前に起点Intentを読み直し、Hard Constraint(Layer 1)を
 *   D1の現行値で再検証する(docs/06 §3の二重化)
 * - recheckSet: 集合(グループ)の全メンバーを読み直して同じ再検証を全ペアへかける
 *   (F4b設計 §2.5・Review Focus 5)
 * match_candidates.latch_scoreへの保存は呼び出し側が行う
 */
import { LATCH } from "@latch/shared";
import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { intents } from "../db/schema";
import type { JevAxes } from "../llm/types";
import { sizeFits } from "./group";
import {
	fetchIntentRows,
	fetchL1DataForRows,
	fetchMembersL1Data,
	layer1Judge,
	pairKey,
} from "./layer1";

type IntentRow = typeof intents.$inferSelect;

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
 * (または不在)なら空集合。それ以外はLayer 1を再実行して合格したotherIdの集合を返す。
 * 起点の行は候補の行と同じ1文で読み、残り3表(users・blocks・proposal_history)は
 * 同時に投げる(D1の直列の待ち2段・#36)。起点がactiveでないときも候補の行は読むが、
 * 読むだけで結果は変わらない
 */
export const recheckHard = async (
	db: DrizzleD1Database,
	originId: string,
	otherIds: string[],
	now: Date,
): Promise<Set<string>> => {
	const rows = await fetchIntentRows(db, [originId, ...otherIds]);
	const origin = rows.find((row) => row.id === originId);
	if (origin === undefined || origin.status !== "active") {
		return new Set();
	}
	// 候補として渡されたidの行だけを判定データへ渡す(起点の行は候補に含めない)
	const wanted = new Set(otherIds);
	const l1 = await fetchL1DataForRows(
		db,
		origin.userId,
		rows.filter((row) => wanted.has(row.id)),
	);
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

/**
 * 集合のHard Constraintの再検証(F4b設計 §2.5)。全メンバーをD1から読み直し、
 * 全員active・全ペアがLayer 1に合格・人数nが全員の区間内なら最新の行(id昇順)を
 * 返す。1人でも不在・active以外・versionの変化(Jev結果が古い内容に基づく)・
 * 不合格ならnull(Jev実行〜提案化の間のpause・削除・更新を拾う・Review Focus 5)
 */
export const recheckSet = async (
	db: DrizzleD1Database,
	members: IntentRow[],
	now: Date,
): Promise<IntentRow[] | null> => {
	const ids = members.map((m) => m.id);
	const versionById = new Map(members.map((m) => [m.id, m.version]));
	const fresh = await db.select().from(intents).where(inArray(intents.id, ids));
	if (
		fresh.length !== ids.length ||
		fresh.some(
			(m) => m.status !== "active" || versionById.get(m.id) !== m.version,
		)
	) {
		return null;
	}
	const sorted = fresh.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (!sizeFits(sorted, sorted.length)) {
		return null;
	}
	const l1 = await fetchMembersL1Data(db, sorted);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			const users = pairKey(sorted[i].userId, sorted[j].userId);
			const judgement = layer1Judge(
				sorted[i],
				sorted[j],
				l1.birthDates,
				l1.blockedPairs.has(users),
				l1.historyPairs.has(users),
				now,
			);
			if (!judgement.pass) {
				return null;
			}
		}
	}
	return sorted;
};
