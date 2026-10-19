import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "./session";

/** localStorageのキー(authSessionと共有) */
const REFRESH_KEY = "latch.refresh";

/** JSON応答のResponseを作る */
const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** fetchのモック(実APIは叩かない) */
const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("authSession", () => {
	it("setTokensはアクセストークンをメモリ・リフレッシュトークンをlocalStorageに置く", () => {
		authSession.setTokens("access-1", "refresh-1");

		expect(authSession.accessToken).toBe("access-1");
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1");
	});

	it("clearはメモリとlocalStorageの両方から取り除く", () => {
		authSession.setTokens("access-1", "refresh-1");

		authSession.clear();

		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
	});

	it("restoreは保存済みリフレッシュトークンで復元し・回転後の値を保存する", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: "access-2",
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		await expect(authSession.restore()).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/auth/refresh");
		expect(JSON.parse(init.body as string)).toEqual({
			refresh_token: "refresh-1",
		});
		expect(authSession.accessToken).toBe("access-2");
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-2");
	});

	it("restoreは保存がなければfetchせずfalseを返す", async () => {
		await expect(authSession.restore()).resolves.toBe(false);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("restoreはリフレッシュ拒否(401)でfalseを返す", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockResolvedValueOnce(
			jsonResponse(401, {
				error: { code: "UNAUTHORIZED", message: "不正です", details: {} },
			}),
		);

		await expect(authSession.restore()).resolves.toBe(false);

		expect(authSession.accessToken).toBeNull();
	});

	it("restoreはサーバーの明示拒否(401)でlocalStorageの失効トークンを除去する(無駄な再試行の防止)", async () => {
		localStorage.setItem(REFRESH_KEY, "stale-refresh");
		fetchMock.mockResolvedValueOnce(
			jsonResponse(401, {
				error: { code: "TOKEN_EXPIRED", message: "期限切れです", details: {} },
			}),
		);

		await expect(authSession.restore()).resolves.toBe(false);

		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
	});

	it("restoreはネットワーク例外ではlocalStorageのトークンを残す(一時的なオフラインで有効なトークンを消さない)", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));

		await expect(authSession.restore()).resolves.toBe(false);

		// 判断不能の失敗のため保存値はそのまま・次回の起動時に再試行できる
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1");
	});

	it("restoreの成功時は保存値を除去しない", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: "access-2",
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		await expect(authSession.restore()).resolves.toBe(true);

		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-2");
	});

	it("refreshの同時多発は1回のfetchに収束する(単一フライト)", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				access_token: "access-2",
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		const results = await Promise.all([
			authSession.refresh(),
			authSession.refresh(),
			authSession.refresh(),
		]);

		expect(results).toEqual([true, true, true]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("ネットワークエラーでもfalseを返す", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));

		await expect(authSession.refresh()).resolves.toBe(false);
	});
});
