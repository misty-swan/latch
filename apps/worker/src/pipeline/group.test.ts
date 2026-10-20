import { LATCH } from "@latch/shared";
import { describe, expect, it } from "vitest";
import type { IntentRow } from "./consumer";
import {
	aggregateOf,
	cosineSimilarity,
	dedupKeyOf,
	enumerateSets,
	type GroupSet,
	intentPairKey,
	type PoolEntry,
	planJevAllocation,
	rankByAggregate,
	selectPool,
	sizeFits,
} from "./group";

/** 試験用のIntentRow。人数条件・id・versionだけ意味を持たせる */
const row = (id: string, min = 3, max = 4, version = 1): IntentRow =>
	({ id, participantsMin: min, participantsMax: max, version }) as IntentRow;

const entry = (id: string, cheapScore: number, max = 4): PoolEntry => ({
	intent: row(id, 3, max),
	cheapScore,
	similarity: 0.5,
});

describe("intentPairKey", () => {
	it("小さいid:大きいid", () => {
		expect(intentPairKey("B", "A")).toBe("A:B");
		expect(intentPairKey("A", "B")).toBe("A:B");
	});
});

describe("sizeFits", () => {
	const members = [row("A", 2, 4), row("B", 3, 4), row("C", 3, 3)];
	it("全員の範囲に入る人数だけtrue", () => {
		expect(sizeFits(members, 3)).toBe(true);
		expect(sizeFits(members, 4)).toBe(false);
		expect(sizeFits(members, 2)).toBe(false);
	});
});

describe("selectPool", () => {
	it("originの上限が3未満なら空", () => {
		expect(selectPool(row("O", 2, 2), [entry("A", 0.9)])).toEqual([]);
	});
	it("上限2の候補は除外する", () => {
		const r = selectPool(row("O"), [entry("A", 0.9, 2), entry("B", 0.5)]);
		expect(r.map((e) => e.intent.id)).toEqual(["B"]);
	});
	it("17件から15件・同点はid昇順", () => {
		const entries = Array.from({ length: 17 }, (_, i) =>
			entry(`I${String(i).padStart(2, "0")}`, i < 2 ? 0.1 : 0.5),
		);
		const r = selectPool(row("O"), entries);
		expect(r).toHaveLength(15);
		expect(r.map((e) => e.intent.id)).toEqual(
			entries.slice(2).map((e) => e.intent.id),
		);
	});
});

describe("cosineSimilarity(再エクスポート)", () => {
	it("同方向1・直交0・零ベクトル0・長さ不一致0", () => {
		expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
		expect(cosineSimilarity([1], [1, 1])).toBe(0);
	});
});

describe("enumerateSets", () => {
	const o = row("O");
	const pool = ["B", "C", "D", "E"].map((id) => row(id));
	it("Pool4件で10集合", () => {
		const sets = enumerateSets(
			o,
			pool,
			() => true,
			() => 0.7,
		);
		expect(sets).toHaveLength(10);
		expect(sets[0].members).toHaveLength(3);
		expect(sets[0].key).toBe("B,C,O");
		expect(sets.at(-1)?.members).toHaveLength(4);
	});
	it("pairOkがfalseのペアを含む集合は消える", () => {
		const sets = enumerateSets(
			o,
			pool,
			(a, b) => intentPairKey(a.id, b.id) !== "B:C",
			() => 0.7,
		);
		expect(sets).toHaveLength(10 - 1 - 2);
		expect(
			sets.every((s) => !(s.key.includes("B") && s.key.includes("C"))),
		).toBe(true);
	});
	it("cheapAggregateは全ペアの最小値", () => {
		const sets = enumerateSets(
			o,
			[row("B"), row("C")],
			() => true,
			(a, b) => (intentPairKey(a.id, b.id) === "B:C" ? 0.4 : 0.9),
		);
		expect(sets[0].cheapAggregate).toBe(0.4);
	});
	it("cheapAggregate降順で並ぶ", () => {
		const cheap: Record<string, number> = {
			"B:C": 0.9,
			"B:O": 0.8,
			"C:O": 0.7,
			"B:D": 0.5,
			"C:D": 0.55,
			"D:O": 0.6,
		};
		const sets = enumerateSets(
			o,
			[row("B"), row("C"), row("D")],
			() => true,
			(a, b) => cheap[intentPairKey(a.id, b.id)],
		);
		expect(sets.map((s) => s.key)).toEqual([
			"B,C,O",
			"C,D,O",
			"B,D,O",
			"B,C,D,O",
		]);
		expect(sets.map((s) => s.cheapAggregate)).toEqual([0.7, 0.55, 0.5, 0.5]);
	});
	it("同点なら3人集合が4人集合より先", () => {
		const sets = enumerateSets(
			o,
			[row("B"), row("C"), row("D")],
			() => true,
			() => 0.7,
		);
		expect(sets.map((s) => s.key)).toEqual([
			"B,C,O",
			"B,D,O",
			"C,D,O",
			"B,C,D,O",
		]);
	});
	it("人数条件を満たさない集合は作らない", () => {
		const sets = enumerateSets(
			row("O", 3, 3),
			pool,
			() => true,
			() => 0.7,
		);
		expect(sets.every((s) => s.members.length === 3)).toBe(true);
	});
});

describe("aggregateOf", () => {
	const m = [row("A"), row("B"), row("C")];
	it("最小値", () => {
		const s = new Map([
			["A:B", 0.9],
			["A:C", 0.7],
			["B:C", 0.8],
		]);
		expect(aggregateOf(m, s)).toBe(0.7);
	});
	it("欠落でnull", () => {
		const s = new Map([
			["A:B", 0.9],
			["A:C", 0.7],
		]);
		expect(aggregateOf(m, s)).toBeNull();
	});
});

describe("rankByAggregate", () => {
	it("0.60ちょうどは除外・同点は人数昇順→key昇順", () => {
		const mk = (key: string, n: number, aggregate: number) => ({
			members: Array.from({ length: n }, (_, i) => row(`${key}${i}`)),
			key,
			aggregate,
		});
		const r = rankByAggregate([
			mk("z", 3, 0.6),
			mk("b", 4, 0.8),
			mk("c", 3, 0.8),
			mk("a", 3, 0.8),
			mk("d", 3, 0.9),
		]);
		expect(r.map((s) => s.key)).toEqual(["d", "a", "c", "b"]);
	});
});

describe("dedupKeyOf", () => {
	it("id昇順のid@version", () => {
		expect(dedupKeyOf([row("B", 3, 4, 2), row("A", 3, 4, 5)])).toBe("A@5,B@2");
	});
});

describe("planJevAllocation", () => {
	const ones = (n: number, p = "o") =>
		Array.from({ length: n }, (_, i) => `${p}${i}:z${i}`);
	const setOf = (ids: string[]): GroupSet => ({
		members: ids.map((i) => row(i)),
		key: ids.join(","),
		cheapAggregate: 0.9,
	});
	const none = new Set<string>();

	it("集合なし・未判定10件は8件まで・capped 2", () => {
		const oo = ones(10);
		const r = planJevAllocation({ oneOnOne: oo, sets: [], known: none });
		expect(r.oneOnOneKeys).toEqual(oo.slice(0, LATCH.JEV_CALLS_PER_EVENT));
		expect(r.oneOnOneCapped).toBe(2);
		expect(r.groupKeys).toEqual([]);
	});

	it("1対1の未判定10件・3人集合1件は1対1が5件・groupKeys 3件・capped 5", () => {
		const r = planJevAllocation({
			oneOnOne: ones(10),
			sets: [setOf(["A", "B", "C"])],
			known: none,
		});
		expect(r.oneOnOneKeys).toHaveLength(5);
		expect(r.groupKeys).toHaveLength(3);
		expect(r.oneOnOneCapped).toBe(5);
		expect(r.plannedSets).toHaveLength(1);
	});

	it("1対1の未判定2件・4人集合は合計8", () => {
		const r = planJevAllocation({
			oneOnOne: ones(2),
			sets: [setOf(["A", "B", "C", "D"])],
			known: none,
		});
		expect(r.oneOnOneKeys).toHaveLength(2);
		expect(r.groupKeys).toHaveLength(6);
		expect(r.oneOnOneCapped).toBe(0);
	});

	it("1対1の未判定6件ではグループ枠4のため4人集合は保留、3人集合は入る", () => {
		const four = setOf(["A", "B", "C", "D"]);
		const three = setOf(["E", "F", "G"]);
		const r = planJevAllocation({
			oneOnOne: ones(6),
			sets: [four, three],
			known: none,
		});
		expect(r.heldSets).toBe(1);
		expect(r.plannedSets).toEqual([three]);
		expect(r.oneOnOneKeys).toHaveLength(5);
		expect(r.groupKeys).toHaveLength(3);
		expect(r.oneOnOneCapped).toBe(1);
	});

	it("集合のペアが1対1の対象と重なればoneOnOneKeysのみに入り1回だけ数える", () => {
		const oo = ["A:B", ...ones(9)];
		const r = planJevAllocation({
			oneOnOne: oo,
			sets: [setOf(["A", "B", "C"])],
			known: none,
		});
		expect(r.oneOnOneKeys).toContain("A:B");
		expect(r.groupKeys).not.toContain("A:B");
		expect(r.groupKeys.sort()).toEqual(["A:C", "B:C"]);
		expect(new Set([...r.oneOnOneKeys, ...r.groupKeys]).size).toBe(
			r.oneOnOneKeys.length + r.groupKeys.length,
		);
		expect(r.oneOnOneKeys.length + r.groupKeys.length).toBeLessThanOrEqual(
			LATCH.JEV_CALLS_PER_EVENT,
		);
		expect(r.oneOnOneCapped).toBe(4);
	});

	it("全ペアknownの集合は枠を使わず、knownの1対1は全件入る", () => {
		const set = setOf(["A", "B", "C"]);
		const oo = ones(10);
		const known = new Set([...oo.slice(0, 6), "A:B", "A:C", "B:C"]);
		const r = planJevAllocation({ oneOnOne: oo, sets: [set], known });
		expect(r.plannedSets).toEqual([set]);
		expect(r.groupKeys).toEqual([]);
		expect(r.oneOnOneKeys).toEqual(oo.slice(0, 6 + 4));
		expect(r.oneOnOneCapped).toBe(0);
	});
});
