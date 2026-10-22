/**
 * インメモリVectorStoreの単体試験(docs/05 §2.3・docs/06 Layer 2)。
 * Vectorizeにはローカルシミュレータが存在しないため、local環境ではこの
 * 実装がLayer 2 Candidate Retrievalの検索を担う。類似度の順序は既知
 * ベクトルで確定させて検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createVectorStore } from "./index";
import {
	holdMemoryVectorWrites,
	memoryVectorStore,
	releaseMemoryVectorWrites,
	resetMemoryVectorStore,
} from "./memory";
import type { StoredVector } from "./types";

/** metadataを補完するヘルパー(form/statusのみ上書きできる) */
const makeVector = (
	id: string,
	values: number[],
	metadata?: Partial<StoredVector["metadata"]>,
): StoredVector => ({
	id,
	values,
	metadata: {
		form: "occasion",
		status: "active",
		category: null,
		user_id: "user-1",
		...metadata,
	},
});

describe("memoryVectorStore(docs/05 §2.3・docs/06 Layer 2)", () => {
	beforeEach(() => {
		resetMemoryVectorStore();
	});

	it("upsert→query: コサイン類似度の降順で既知ベクトルの順序とスコアを返す", async () => {
		const store = memoryVectorStore();
		// クエリ=[1,0]に対し、同方向=1・斜め≈0.7071・直交=0 の順になる既知構成
		await store.upsert([
			makeVector("id-a", [1, 0]),
			makeVector("id-b", [0.7, 0.7]),
			makeVector("id-c", [0, 1]),
		]);

		const hits = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});

		expect(hits.map((h) => h.id)).toEqual(["id-a", "id-b", "id-c"]);
		expect(hits[0]?.score).toBeCloseTo(1, 12);
		expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 12);
		expect(hits[2]?.score).toBeCloseTo(0, 12);
	});

	it("hold中のupsertはgetByIds・queryから見えず、releaseで見える", async () => {
		const store = memoryVectorStore();
		holdMemoryVectorWrites();
		await store.upsert([makeVector("held", [1, 0])]);
		const filter = { form: "occasion", status: "active" };
		expect(await store.getByIds(["held"])).toEqual([null]);
		expect(await store.query([1, 0], { topK: 10, filter })).toEqual([]);

		releaseMemoryVectorWrites();
		expect((await store.getByIds(["held"]))[0]?.id).toBe("held");
		expect(await store.query([1, 0], { topK: 10, filter })).toHaveLength(1);
	});

	it("hold中のupsertはresetで破棄され、以降のupsertは即時に見える", async () => {
		const store = memoryVectorStore();
		holdMemoryVectorWrites();
		await store.upsert([makeVector("held", [1, 0])]);
		resetMemoryVectorStore();
		releaseMemoryVectorWrites();
		expect(await store.getByIds(["held"])).toEqual([null]);
		await store.upsert([makeVector("now", [1, 0])]);
		expect((await store.getByIds(["now"]))[0]?.id).toBe("now");
	});

	it("query: topKで切り詰める", async () => {
		const store = memoryVectorStore();
		await store.upsert([
			makeVector("id-a", [1, 0]),
			makeVector("id-b", [0.9, 0.1]),
			makeVector("id-c", [0.8, 0.2]),
		]);

		const hits = await store.query([1, 0], {
			topK: 2,
			filter: { form: "occasion", status: "active" },
		});

		expect(hits).toHaveLength(2);
		// 上位2件のみ(降順の先頭から)
		expect(hits.map((h) => h.id)).toEqual(["id-a", "id-b"]);
	});

	it("query: filterのform不一致ベクトル(自分と同方向)を返さない", async () => {
		const store = memoryVectorStore();
		// クエリと完全同方向だがformが異なるベクトルは、類似度1でも返さない
		await store.upsert([
			makeVector("self", [1, 0]),
			makeVector("other-form", [1, 0], {
				form: "connection",
			}),
		]);

		const hits = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});

		expect(hits.map((h) => h.id)).toEqual(["self"]);
	});

	it("query: filterのstatus不一致ベクトルを返さない", async () => {
		const store = memoryVectorStore();
		await store.upsert([
			makeVector("active-1", [1, 0]),
			makeVector("paused-1", [1, 0], { status: "paused" }),
		]);

		const hits = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});

		expect(hits.map((h) => h.id)).toEqual(["active-1"]);
	});

	it("query: ゼロベクトルはスコア0(ゼロ除算ガード)でNaNを返さない", async () => {
		const store = memoryVectorStore();
		await store.upsert([
			makeVector("zero", [0, 0]),
			makeVector("normal", [1, 0]),
		]);

		// クエリ側がゼロベクトルでもストア側がゼロでも0に倒す
		const hitsFromZeroQuery = await store.query([0, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});
		expect(hitsFromZeroQuery.map((h) => h.score)).toEqual([0, 0]);
	});

	it("query: 同スコアはid昇順で決定的", async () => {
		const store = memoryVectorStore();
		await store.upsert([
			makeVector("id-c", [1, 0]),
			makeVector("id-a", [1, 0]),
			makeVector("id-b", [1, 0]),
		]);

		const hits = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});

		// スコアは全件1.0で同点 → id昇順に固定される
		expect(hits.map((h) => h.id)).toEqual(["id-a", "id-b", "id-c"]);
	});

	it("getByIds: 在るidはStoredVector・無いidはnull(入力順)", async () => {
		const store = memoryVectorStore();
		const stored = makeVector("id-1", [1, 0], { user_id: "user-9" });
		await store.upsert([stored]);

		const got = await store.getByIds(["id-1", "missing", "id-1"]);

		expect(got).toEqual([stored, null, stored]);
	});

	it("deleteByIds: 削除後はquery・getByIdsから消える", async () => {
		const store = memoryVectorStore();
		await store.upsert([makeVector("id-1", [1, 0])]);

		await store.deleteByIds(["id-1"]);

		expect(await store.getByIds(["id-1"])).toEqual([null]);
		const hits = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});
		expect(hits).toEqual([]);
	});

	it("upsert: 同一id再upsertは上書き(重複せず新values・metadataで検索される)", async () => {
		const store = memoryVectorStore();
		await store.upsert([makeVector("id-1", [1, 0])]);
		// 同一idを直交方向へ更新し、statusも変更
		await store.upsert([makeVector("id-1", [0, 1], { status: "paused" })]);

		// 直交方向の旧状態では外れ、新filter(新direction・activeのみ)で確認
		const before = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});
		expect(before).toEqual([]);

		await store.upsert([makeVector("id-1", [1, 0])]);
		const after = await store.query([1, 0], {
			topK: 10,
			filter: { form: "occasion", status: "active" },
		});
		expect(after).toEqual([{ id: "id-1", score: 1 }]);
	});

	it("reset: resetMemoryVectorStoreで空になり、インスタンスは同一(シングルトン)", async () => {
		const store = memoryVectorStore();
		expect(memoryVectorStore()).toBe(store);

		await store.upsert([makeVector("id-1", [1, 0])]);
		resetMemoryVectorStore();

		expect(await store.getByIds(["id-1"])).toEqual([null]);
	});
});

describe("createVectorStore(実装の選択)", () => {
	beforeEach(() => {
		resetMemoryVectorStore();
	});

	it("LATCH_ENV=localはインメモリ実装(シングルトンと同一インスタンス)", () => {
		const env = { LATCH_ENV: "local" } as unknown as Env;
		expect(createVectorStore(env)).toBe(memoryVectorStore());
	});

	it("local以外はenv.VECTORSをラップし、queryをVectorizeのfilter形状へ委譲する", async () => {
		// env.VECTORSの代わりの最小フェイク(queryの委譲と引数形状のみ確認する薄さ)
		const query = vi.fn(async () => ({
			matches: [{ id: "vec-1", score: 0.5 }],
			count: 1,
		}));
		const env = {
			LATCH_ENV: "staging",
			VECTORS: { query },
		} as unknown as Env;

		const store = createVectorStore(env);
		const hits = await store.query([1, 0], {
			topK: 7,
			filter: { form: "occasion", status: "active" },
		});

		expect(hits).toEqual([{ id: "vec-1", score: 0.5 }]);
		expect(query).toHaveBeenCalledWith([1, 0], {
			topK: 7,
			filter: {
				form: { $eq: "occasion" },
				status: { $eq: "active" },
			},
		});
	});
});
