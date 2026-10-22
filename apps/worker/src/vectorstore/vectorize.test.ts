/**
 * VectorStoreのVectorize実装の単体試験(docs/05 §2.3)。
 * metadataのversion(反映確認に使う・不具合の修正工程の設計 §2.3)が
 * 書き込みと読み出しで往復することを、VectorizeIndexの最小フェイクで確かめる。
 */
import { describe, expect, it } from "vitest";
import type { StoredVector } from "./types";
import { createVectorizeStore } from "./vectorize";

type FakeRecord = {
	id: string;
	values: number[];
	metadata?: Record<string, unknown>;
};

/** upsertで受けた形をそのまま保持し、getByIdsで返す最小のフェイク */
const fakeIndex = () => {
	const rows = new Map<string, FakeRecord>();
	const index = {
		upsert: async (vectors: FakeRecord[]) => {
			for (const v of vectors) {
				rows.set(v.id, v);
			}
			return { ids: vectors.map((v) => v.id), count: vectors.length };
		},
		getByIds: async (ids: string[]) =>
			ids.flatMap((id) => {
				const row = rows.get(id);
				return row === undefined ? [] : [row];
			}),
	};
	return { rows, index: index as unknown as VectorizeIndex };
};

const vector = (version?: number): StoredVector => ({
	id: "vec-1",
	values: [1, 0],
	metadata: {
		form: "connection",
		status: "active",
		category: null,
		user_id: "user-1",
		...(version === undefined ? {} : { version }),
	},
});

describe("createVectorizeStore(metadataのversion)", () => {
	it("versionは数値のまま書き込まれ、読み出しで復元される", async () => {
		const { rows, index } = fakeIndex();
		const store = createVectorizeStore(index);
		await store.upsert([vector(3)]);
		expect(rows.get("vec-1")?.metadata).toEqual({
			form: "connection",
			status: "active",
			user_id: "user-1",
			version: 3,
		});
		const [read] = await store.getByIds(["vec-1"]);
		expect(read?.metadata.version).toBe(3);
		expect(read?.metadata.category).toBeNull();
	});

	it("versionが無ければキーを書かず、読み出しはundefined", async () => {
		const { rows, index } = fakeIndex();
		const store = createVectorizeStore(index);
		await store.upsert([vector()]);
		expect(rows.get("vec-1")?.metadata).not.toHaveProperty("version");
		const [read] = await store.getByIds(["vec-1"]);
		expect(read?.metadata.version).toBeUndefined();
	});

	it("versionが文字列で届いたらundefinedとして扱う(反映済みと誤らない)", async () => {
		const { rows, index } = fakeIndex();
		rows.set("vec-1", {
			id: "vec-1",
			values: [1, 0],
			metadata: {
				form: "connection",
				status: "active",
				user_id: "user-1",
				version: "3",
			},
		});
		const store = createVectorizeStore(index);
		const [read] = await store.getByIds(["vec-1"]);
		expect(read?.metadata.version).toBeUndefined();
	});
});
