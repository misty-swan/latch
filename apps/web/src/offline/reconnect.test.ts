import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import {
	clearOfflineCache,
	OFFLINE_CACHE_KEY,
	type OfflineStore,
} from "./persister";
import { startReconnect } from "./reconnect";

const REFRESH_KEY = "latch.refresh";

const fakeJwt = (payload: Record<string, unknown>): string => {
	const encode = (value: unknown): string =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.sig`;
};

const fetchMock = vi.fn();
const cleanups: (() => void)[] = [];

/** オフライン中のセッションにする(保存済みリフレッシュトークン+通信失敗のrestore) */
const goOffline = async (): Promise<void> => {
	localStorage.setItem(REFRESH_KEY, "refresh-1");
	localStorage.setItem("latch.uid", "U1");
	fetchMock.mockRejectedValueOnce(new TypeError("network down"));
	await authSession.restore();
	expect(authSession.offline).toBe(true);
};

/** onlineイベントを送り・後続の非同期処理を待つ */
const fireOnline = async (target: EventTarget): Promise<void> => {
	target.dispatchEvent(new Event("online"));
	await vi.waitFor(() => {
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

describe("startReconnect", () => {
	it("onlineイベントでオフライン中ならrestoreし・成功で取得をやり直す", async () => {
		await goOffline();
		const client = new QueryClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const target = new EventTarget();
		cleanups.push(startReconnect(client, target));
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: fakeJwt({ sub: "U1" }),
					refresh_token: "refresh-2",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await fireOnline(target);

		expect(authSession.offline).toBe(false);
		expect(authSession.accessToken).not.toBeNull();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("オフライン中でなければrestoreしない", async () => {
		const client = new QueryClient();
		const target = new EventTarget();
		cleanups.push(startReconnect(client, target));

		target.dispatchEvent(new Event("online"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("拒否ならonClear経由で端末の保存が消え・取得はやり直さない(RF 2)", async () => {
		await goOffline();
		const data = new Map<string, unknown>([
			[OFFLINE_CACHE_KEY, { userId: "U1" }],
		]);
		const store: OfflineStore = {
			get: async (key) => data.get(key),
			set: async (key, value) => {
				data.set(key, value);
			},
			del: async (key) => {
				data.delete(key);
			},
		};
		const client = new QueryClient();
		client.setQueryData(["intents"], { items: [] });
		const invalidate = vi.spyOn(client, "invalidateQueries");
		cleanups.push(
			authSession.onClear(() => void clearOfflineCache(client, store)),
		);
		const target = new EventTarget();
		const goWelcome = vi.fn();
		cleanups.push(startReconnect(client, target, goWelcome));
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		await fireOnline(target);

		expect(goWelcome).toHaveBeenCalledTimes(1);
		expect(authSession.offline).toBe(false);
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
		expect(data.size).toBe(0);
		expect(client.getQueryCache().getAll()).toEqual([]);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("通信の失敗でオフライン中のままならようこそ画面へ移らない", async () => {
		await goOffline();
		const target = new EventTarget();
		const goWelcome = vi.fn();
		cleanups.push(startReconnect(new QueryClient(), target, goWelcome));
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));

		await fireOnline(target);

		expect(authSession.offline).toBe(true);
		expect(goWelcome).not.toHaveBeenCalled();
	});

	it("解除後はonlineイベントに反応しない", async () => {
		await goOffline();
		const target = new EventTarget();
		startReconnect(new QueryClient(), target)();

		target.dispatchEvent(new Event("online"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
