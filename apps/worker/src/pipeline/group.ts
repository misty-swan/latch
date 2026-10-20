/**
 * グループLATCH(F4b設計 §2)の集合に関する純関数群。
 *
 * 人数条件・Pool選定・集合の列挙・点数の集約だけを担い、DB・時刻・LLMに触れない。
 * 時間・予算・地域の両立はペア単位のLayer 1(pairOk)が担う。区間の性質上、全ペアが
 * 15分以上重なれば全員の共通部分も15分以上になるため、n人の時間判定は置かない
 * (F4b設計 §2.3)。
 */
import { LATCH } from "@latch/shared";
import type { IntentRow } from "./consumer";

/** 2つのIntent idの順序なしペアキー(小さいid:大きいid) */
export const intentPairKey = (a: string, b: string): string =>
	a < b ? `${a}:${b}` : `${b}:${a}`;

/**
 * 人数nの集合が全メンバーの人数条件(participantsMin ≤ n ≤ participantsMax)を
 * 満たすか。1対1(n=2)にも適用する(F4b設計 §2.1)
 */
export const sizeFits = (members: IntentRow[], n: number): boolean =>
	members.every((m) => m.participantsMin <= n && n <= m.participantsMax);

/** Pool候補1件(origin視点のLayer 3スコアと類似度) */
export interface PoolEntry {
	intent: IntentRow;
	cheapScore: number;
	similarity: number;
}

/**
 * originのPoolを選ぶ。originが3人以上を許さなければ空。participantsMax≥3の候補を
 * cheapScore降順・同点id昇順で最大GROUP_POOL_MAX件(F4b設計 §2.2)
 */
export const selectPool = (
	origin: IntentRow,
	entries: PoolEntry[],
): PoolEntry[] => {
	if (origin.participantsMax < LATCH.GROUP_SIZE_MIN) {
		return [];
	}
	return entries
		.filter((e) => e.intent.participantsMax >= LATCH.GROUP_SIZE_MIN)
		.sort(
			(a, b) =>
				b.cheapScore - a.cheapScore ||
				(a.intent.id < b.intent.id ? -1 : a.intent.id > b.intent.id ? 1 : 0),
		)
		.slice(0, LATCH.GROUP_POOL_MAX);
};

/** コサイン類似度。長さ不一致・零ベクトルは0 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
	if (a.length !== b.length) {
		return 0;
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) {
		return 0;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/** 列挙された集合の候補 */
export interface GroupSet {
	/** id昇順 */
	members: IntentRow[];
	/** idをカンマ結合 */
	key: string;
	/** 全ペアのpairCheapの最小値 */
	cheapAggregate: number;
}

/** 数値降順→人数昇順→key昇順の共通比較 */
const byScoreThenSizeThenKey = (
	a: { members: IntentRow[]; key: string },
	b: { members: IntentRow[]; key: string },
	scoreA: number,
	scoreB: number,
): number =>
	scoreB - scoreA ||
	a.members.length - b.members.length ||
	(a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * originを含む3人・4人の集合を列挙する(F4b設計 §2.3)。全ペアがpairOk、かつ
 * sizeFitsを満たすもののみ。並びはcheapAggregate降順→人数昇順→key昇順
 */
export const enumerateSets = (
	origin: IntentRow,
	pool: IntentRow[],
	pairOk: (a: IntentRow, b: IntentRow) => boolean,
	pairCheap: (a: IntentRow, b: IntentRow) => number,
): GroupSet[] => {
	const others = pool.filter((p) => p.id !== origin.id);
	const sets: GroupSet[] = [];
	const choose = (start: number, picked: IntentRow[], need: number): void => {
		if (need === 0) {
			const members = [origin, ...picked].sort((a, b) =>
				a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
			);
			if (!sizeFits(members, members.length)) {
				return;
			}
			let min = Number.POSITIVE_INFINITY;
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < members.length; j++) {
					if (!pairOk(members[i], members[j])) {
						return;
					}
					min = Math.min(min, pairCheap(members[i], members[j]));
				}
			}
			sets.push({
				members,
				key: members.map((m) => m.id).join(","),
				cheapAggregate: min,
			});
			return;
		}
		for (let i = start; i < others.length; i++) {
			choose(i + 1, [...picked, others[i]], need - 1);
		}
	};
	for (let n = LATCH.GROUP_SIZE_MIN; n <= LATCH.GROUP_SIZE_MAX; n++) {
		choose(0, [], n - 1);
	}
	return sets.sort((a, b) =>
		byScoreThenSizeThenKey(a, b, a.cheapAggregate, b.cheapAggregate),
	);
};

/** 全ペアのscoreの最小値。1ペアでも欠ければnull(F4b設計 §2.4) */
export const aggregateOf = (
	members: IntentRow[],
	scoreByPair: Map<string, number>,
): number | null => {
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			const score = scoreByPair.get(
				intentPairKey(members[i].id, members[j].id),
			);
			if (score === undefined) {
				return null;
			}
			min = Math.min(min, score);
		}
	}
	return min;
};

/**
 * aggregate > LATCH.THRESHOLD(ちょうどは提案しない)の集合だけを、
 * aggregate降順→人数昇順→key昇順に並べる
 */
export const rankByAggregate = <
	T extends { members: IntentRow[]; key: string; aggregate: number },
>(
	sets: T[],
): T[] =>
	sets
		.filter((s) => s.aggregate > LATCH.THRESHOLD)
		.sort((a, b) => byScoreThenSizeThenKey(a, b, a.aggregate, b.aggregate));

/** id昇順の`${id}@${version}`をカンマ結合(proposal dedup_keyの定義) */
export const dedupKeyOf = (members: IntentRow[]): string =>
	[...members]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((m) => `${m.id}@${m.version}`)
		.join(",");
