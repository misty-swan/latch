import { describe, expect, it } from "vitest";
import type { IntentRow } from "./consumer";
import {
	aggregateOf,
	cosineSimilarity,
	dedupKeyOf,
	enumerateSets,
	intentPairKey,
	type PoolEntry,
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
