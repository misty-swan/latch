/**
 * 取得結果の端末への保存(F8a設計 §2.1)。
 * - 保存するのはIntentの一覧・提案の一覧・つながり一覧・自分の4つのキー(完全一致)の成功した結果だけ
 *   (チャットの本文・アプリ内通知・単一のLATCH・Intentの単一取得等は保存しない)
 * - 保存先はIndexedDB(idb-keyval)。保存値は{ userId, client }で、利用者IDが現在と異なる保存は
 *   読まずに消す(別の利用者の内容を見せない)。利用者IDが無いときは保存しない
 * - IndexedDBが使えない端末(例外)では保存せず、例外を外へ出さない(表示は通常の取得に任せる)
 * - 保存はキャッシュ全体の書き出しなので、4つのキーは保存期間のあいだメモリからも捨てない
 *   (既定の5分で捨てると、捨てた後の書き出しで端末の保存からも消える)
 * - 変更(mutation)は保存しない。オフラインでも一時停止させずにその場で失敗させる
 *   (止めた変更が接続の回復で黙って送られるのを防ぎ、オフラインの案内を出すため)
 */

import { hashKey, type Query, QueryClient } from "@tanstack/react-query";
import type {
	PersistedClient,
	Persister,
} from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import { CONNECTIONS_QUERY_KEY } from "../chat/queries";
import { INTENTS_QUERY_KEY } from "../intents/queries";
import { PROPOSALS_QUERY_KEY } from "../latches/queries";
import { ME_QUERY_KEY } from "../me/queries";

/** IndexedDB上の保存のキー */
export const OFFLINE_CACHE_KEY = "latch.offline-cache";
/** 保存期間(7日)。これより古い保存は読まずに捨てる */
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 3_600_000;

/** 保存するクエリのキー(この4つだけ・完全一致) */
export const PERSISTED_QUERY_KEYS: readonly (readonly unknown[])[] = [
	INTENTS_QUERY_KEY,
	PROPOSALS_QUERY_KEY,
	CONNECTIONS_QUERY_KEY,
	ME_QUERY_KEY,
];

const PERSISTED_HASHES: ReadonlySet<string> = new Set(
	PERSISTED_QUERY_KEYS.map((key) => hashKey(key)),
);

/** 保存の対象か(成功した結果で、キーが4つのいずれかと完全一致) */
export const shouldPersistQuery = (query: Query): boolean =>
	query.state.status === "success" && PERSISTED_HASHES.has(query.queryHash);

/** 保存先(既定はIndexedDB。試験ではメモリへ差し替える) */
export interface OfflineStore {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: unknown) => Promise<void>;
	del: (key: string) => Promise<void>;
}

/** IndexedDBが無い・使えない環境では何もしない(get=undefined)。例外は外へ出さない */
const idbStore: OfflineStore = {
	get: async (key) => {
		try {
			return await get(key);
		} catch {
			return undefined;
		}
	},
	set: async (key, value) => {
		try {
			await set(key, value);
		} catch {
			// 保存できなくても表示は通常の取得で成り立つ
		}
	},
	del: async (key) => {
		try {
			await del(key);
		} catch {
			// 消せない保存先には、そもそも保存できていない
		}
	},
};

/** 端末に置く形(利用者IDとTanStack Queryの保存内容) */
interface StoredCache {
	userId: string;
	client: PersistedClient;
}

const isStoredCache = (value: unknown): value is StoredCache =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { userId?: unknown }).userId === "string" &&
	typeof (value as { client?: unknown }).client === "object" &&
	(value as { client?: unknown }).client !== null;

/** 差し替えた保存先の例外も外へ出さない */
const quietly = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
	try {
		return await run();
	} catch {
		return undefined;
	}
};

/** 利用者IDに紐づけて保存するPersisterを作る */
export const createOfflinePersister = (
	getUserId: () => string | null,
	store: OfflineStore = idbStore,
): Persister => ({
	persistClient: async (client) => {
		const userId = getUserId();
		if (userId === null) {
			return;
		}
		const value: StoredCache = { userId, client };
		await quietly(() => store.set(OFFLINE_CACHE_KEY, value));
	},
	restoreClient: async () => {
		const value = await quietly(() => store.get(OFFLINE_CACHE_KEY));
		if (value === undefined) {
			return undefined;
		}
		if (!isStoredCache(value) || value.userId !== getUserId()) {
			// 別の利用者・形の崩れた保存は読まずに消す
			await quietly(() => store.del(OFFLINE_CACHE_KEY));
			return undefined;
		}
		return value.client;
	},
	removeClient: async () => {
		await quietly(() => store.del(OFFLINE_CACHE_KEY));
	},
});

/**
 * アプリのQueryClientを作る。
 * - 変更はnetworkMode "always"(オフラインでも送ろうとし、通信の失敗としてonErrorへ届く)
 * - 保存する4つのキーはgcTimeを保存期間にそろえる(復元しただけで画面に出ていない間も捨てない)。
 *   既定の設定は前方一致なので["intents", id]にも及ぶが、メモリ上に残るだけで保存はされない
 */
export const createAppQueryClient = (): QueryClient => {
	const client = new QueryClient({
		defaultOptions: { mutations: { networkMode: "always" } },
	});
	for (const queryKey of PERSISTED_QUERY_KEYS) {
		client.setQueryDefaults(queryKey, { gcTime: OFFLINE_MAX_AGE_MS });
	}
	return client;
};

/** PersistQueryClientProviderへ渡す設定(4つのキーの成功した結果だけ・変更は保存しない) */
export const createPersistOptions = (persister: Persister) => ({
	persister,
	maxAge: OFFLINE_MAX_AGE_MS,
	dehydrateOptions: {
		shouldDehydrateQuery: shouldPersistQuery,
		shouldDehydrateMutation: () => false,
	},
});

/** メモリ上のキャッシュと端末の保存を消す(ログアウト・ログインの拒否のとき) */
export const clearOfflineCache = async (
	queryClient: QueryClient,
	store: OfflineStore = idbStore,
): Promise<void> => {
	queryClient.clear();
	await quietly(() => store.del(OFFLINE_CACHE_KEY));
};
