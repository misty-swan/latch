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
import { pairKey } from "./layer1";

/** 2つのIntent idの順序なしペアキー(小さいid:大きいid・layer1のpairKeyと同一規則) */
export const intentPairKey = (a: string, b: string): string => pairKey(a, b);

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

export { cosineSimilarity } from "../vectorstore/similarity";

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

/** Jev配分の入力 */
export interface AllocationInput {
	/** 1対1の対象(人数条件・履歴除外済み・Layer 3降順)。keyはintentPairKey */
	oneOnOne: string[];
	/** enumerateSetsの順の集合 */
	sets: GroupSet[];
	/** jev_resultが既にあるペア */
	known: Set<string>;
}

/** Jev配分の計画 */
export interface AllocationPlan {
	/** runLayer4へ渡す1対1のキー(known分は全件+未判定の選ばれた分。L3順。集合と重なる未判定ペアも含む) */
	oneOnOneKeys: string[];
	/** 枠に収まらなかった1対1の未判定件数(jev_heldのcapへ加算) */
	oneOnOneCapped: number;
	/** グループ用に新たにJevへ渡すキー(oneOnOneKeysと重複しない) */
	groupKeys: string[];
	/** 全ペアが既知または予定済みの集合(順序はsetsのまま) */
	plannedSets: GroupSet[];
	/** 未判定ペアが枠に収まらず予定に入らなかった集合の数 */
	heldSets: number;
}

const setPairKeys = (set: GroupSet): string[] => {
	const keys: string[] = [];
	for (let i = 0; i < set.members.length; i++) {
		for (let j = i + 1; j < set.members.length; j++) {
			keys.push(intentPairKey(set.members[i].id, set.members[j].id));
		}
	}
	return keys;
};

/**
 * 1イベントのJev呼び出し(JEV_CALLS_PER_EVENT)を1対1とグループで分ける
 * (F4b設計 §2.5)。1対1の未判定には最低JEV_ONE_ON_ONE_MINを保証し、残りを
 * 集合の未判定ペアへ回す。集合のペアが1対1の対象と重なる場合は1対1側
 * (oneOnOneKeys)に含め、枠は1回だけ数える
 */
export const planJevAllocation = (input: AllocationInput): AllocationPlan => {
	const { oneOnOne, sets, known } = input;
	const total = LATCH.JEV_CALLS_PER_EVENT;
	const need1 = oneOnOne.filter((k) => !known.has(k));
	const need1Set = new Set(need1);
	const groupCap = total - Math.min(LATCH.JEV_ONE_ON_ONE_MIN, need1.length);

	const scheduled = new Set<string>();
	const plannedSets: GroupSet[] = [];
	let heldSets = 0;
	for (const set of sets) {
		const missing = setPairKeys(set).filter(
			(k) => !known.has(k) && !scheduled.has(k),
		);
		if (scheduled.size + missing.length <= groupCap) {
			for (const k of missing) {
				scheduled.add(k);
			}
			plannedSets.push(set);
		} else {
			heldSets += 1;
		}
	}

	const groupKeys = [...scheduled].filter((k) => !need1Set.has(k));
	const rest1 = need1.filter((k) => !scheduled.has(k));
	const slots1 = Math.min(rest1.length, total - scheduled.size);
	const chosen = new Set(rest1.slice(0, slots1));
	const oneOnOneKeys = oneOnOne.filter(
		(k) => known.has(k) || chosen.has(k) || scheduled.has(k),
	);
	return {
		oneOnOneKeys,
		oneOnOneCapped: rest1.length - slots1,
		groupKeys,
		plannedSets,
		heldSets,
	};
};
