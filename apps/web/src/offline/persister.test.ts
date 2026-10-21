import { QueryClient } from "@tanstack/react-query";
import {
	persistQueryClientRestore,
	persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { describe, expect, it } from "vitest";
import {
	clearOfflineCache,
	createOfflinePersister,
	OFFLINE_CACHE_KEY,
	OFFLINE_MAX_AGE_MS,
	type OfflineStore,
	PERSISTED_QUERY_KEYS,
	shouldPersistQuery,
} from "./persister";

/** メモリ上の保存先(IndexedDBの差し替え) */
const memoryStore = (): OfflineStore & { data: Map<string, unknown> } => {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (key) => data.get(key),
		set: async (key, value) => {
			data.set(key, value);
		},
		del: async (key) => {
			data.delete(key);
		},
	};
};

/** 指定のキーへ成功の結果を入れたQueryClient */
const clientWith = (...keys: (readonly unknown[])[]): QueryClient => {
	const client = new QueryClient();
	for (const key of keys) {
		client.setQueryData(key, { items: [String(key[0])] });
	}
	return client;
};

const persistedKeys = (client: QueryClient): unknown[] =>
	client
		.getQueryCache()
		.getAll()
		.filter(shouldPersistQuery)
		.map((query) => query.queryKey);

describe("shouldPersistQuery", () => {
	it("4つのキーの成功した結果だけを保存の対象にする", () => {
		const client = clientWith(
			["intents"],
			["latches", "proposals"],
			["latches", "connections"],
			["me"],
			["intents", "I1"],
			["latches", "L1"],
			["messages", "L1"],
			["notifications"],
		);

		expect(persistedKeys(client)).toEqual([
			["intents"],
			["latches", "proposals"],
			["latches", "connections"],
			["me"],
		]);
		expect(PERSISTED_QUERY_KEYS).toHaveLength(4);
	});

	it("失敗した['intents']は対象外", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await client
			.fetchQuery({
				queryKey: ["intents"],
				queryFn: () => Promise.reject(new Error("boom")),
			})
			.catch(() => undefined);

		expect(persistedKeys(client)).toEqual([]);
	});
});

describe("createOfflinePersister", () => {
	const save = (
		client: QueryClient,
		persister: ReturnType<typeof createOfflinePersister>,
	) =>
		persistQueryClientSave({
			queryClient: client,
			persister,
			dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
		});

	const restoreInto = async (
		persister: ReturnType<typeof createOfflinePersister>,
	): Promise<QueryClient> => {
		const client = new QueryClient();
		await persistQueryClientRestore({
			queryClient: client,
			persister,
			maxAge: OFFLINE_MAX_AGE_MS,
		});
		return client;
	};

	it("U1で保存し・U1で復元できる(対象外のキーは保存しない)", async () => {
		const store = memoryStore();
		const persister = createOfflinePersister(() => "U1", store);

		await save(
			clientWith(["latches", "proposals"], ["latches", "L1"]),
			persister,
		);

		expect(store.data.has(OFFLINE_CACHE_KEY)).toBe(true);
		expect(
			(store.data.get(OFFLINE_CACHE_KEY) as { userId: string }).userId,
		).toBe("U1");
		const restored = await restoreInto(persister);
		expect(restored.getQueryData(["latches", "proposals"])).toEqual({
			items: ["latches"],
		});
		expect(restored.getQueryData(["latches", "L1"])).toBeUndefined();
	});

	it("別の利用者(U2)では復元せず・保存を消す(RF 1)", async () => {
		const store = memoryStore();
		let userId = "U1";
		const persister = createOfflinePersister(() => userId, store);
		await save(clientWith(["intents"]), persister);

		userId = "U2";
		await expect(persister.restoreClient()).resolves.toBeUndefined();

		expect(store.data.has(OFFLINE_CACHE_KEY)).toBe(false);
		const restored = await restoreInto(persister);
		expect(restored.getQueryData(["intents"])).toBeUndefined();
	});

	it("利用者IDが無いときは保存しない", async () => {
		const store = memoryStore();
		const persister = createOfflinePersister(() => null, store);

		await save(clientWith(["intents"]), persister);

		expect(store.data.size).toBe(0);
	});

	it("removeClientで保存を消す", async () => {
		const store = memoryStore();
		const persister = createOfflinePersister(() => "U1", store);
		await save(clientWith(["me"]), persister);

		await persister.removeClient();

		expect(store.data.size).toBe(0);
	});

	it("保存先が例外を投げても外へ出さない(IndexedDBが使えない端末)", async () => {
		const broken: OfflineStore = {
			get: () => Promise.reject(new Error("no idb")),
			set: () => Promise.reject(new Error("no idb")),
			del: () => Promise.reject(new Error("no idb")),
		};
		const persister = createOfflinePersister(() => "U1", broken);

		await expect(save(clientWith(["me"]), persister)).resolves.toBeUndefined();
		await expect(persister.restoreClient()).resolves.toBeUndefined();
		await expect(persister.removeClient()).resolves.toBeUndefined();
	});

	it("既定の保存先(IndexedDBが無い環境)でも例外を外へ出さない", async () => {
		const persister = createOfflinePersister(() => "U1");

		await expect(save(clientWith(["me"]), persister)).resolves.toBeUndefined();
		await expect(persister.restoreClient()).resolves.toBeUndefined();
	});
});

describe("clearOfflineCache", () => {
	it("メモリ上のキャッシュと端末の保存の両方を空にする", async () => {
		const store = memoryStore();
		const client = clientWith(["intents"], ["me"]);
		await persistQueryClientSave({
			queryClient: client,
			persister: createOfflinePersister(() => "U1", store),
			dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
		});

		await clearOfflineCache(client, store);

		expect(client.getQueryCache().getAll()).toEqual([]);
		expect(store.data.size).toBe(0);
	});

	it("保存期間は7日", () => {
		expect(OFFLINE_MAX_AGE_MS).toBe(7 * 24 * 3_600_000);
		expect(OFFLINE_CACHE_KEY).toBe("latch.offline-cache");
	});
});
