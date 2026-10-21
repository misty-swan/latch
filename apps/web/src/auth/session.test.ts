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

describe("authSession.logout", () => {
	it("beforeClearを待ち・refresh_tokenとBearerを付けてAPIを呼んでからclearする", async () => {
		authSession.setTokens("access-1", "refresh-1");
		const order: string[] = [];
		fetchMock.mockImplementationOnce(async (_u, init) => {
			order.push("api");
			expect(JSON.parse(String(init.body))).toEqual({
				refresh_token: "refresh-1",
			});
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer access-1",
			);
			return new Response(null, { status: 204 });
		});

		await authSession.logout(async () => {
			order.push("before");
		});

		expect(order).toEqual(["before", "api"]);
		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
	});

	it("beforeClearが投げてもAPI失敗でもclearまで進む", async () => {
		authSession.setTokens("access-1", "refresh-1");
		fetchMock.mockRejectedValueOnce(new Error("offline"));

		await authSession.logout(async () => {
			throw new Error("push失敗");
		});

		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
	});

	it("401ならリフレッシュして回転後のトークンで1回再試行し・clearまで進む", async () => {
		authSession.setTokens("access-old", "refresh-1");
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(
				jsonResponse(200, {
					access_token: "access-new",
					refresh_token: "refresh-2",
					expires_in: 900,
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		await authSession.logout();

		expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
			"/v1/auth/logout",
			"/v1/auth/refresh",
			"/v1/auth/logout",
		]);
		const retry = fetchMock.mock.calls[2][1];
		expect(new Headers(retry.headers).get("Authorization")).toBe(
			"Bearer access-new",
		);
		expect(JSON.parse(String(retry.body))).toEqual({
			refresh_token: "refresh-2",
		});
		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
	});
});

/** JWT風の文字列を作る(署名は検証しないので適当でよい) */
const fakeJwt = (payload: Record<string, unknown>): string => {
	const encode = (value: unknown): string =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.sig`;
};

const UID_KEY = "latch.uid";

describe("authSession.userId", () => {
	it("setTokensでJWTのsubを読み・latch.uidへ保存する", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");

		expect(authSession.userId).toBe("U1");
		expect(localStorage.getItem(UID_KEY)).toBe("U1");
	});

	it("リフレッシュ成功でも新しいトークンのsubを保存する", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: fakeJwt({ sub: "U2" }),
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		await authSession.restore();

		expect(authSession.userId).toBe("U2");
		expect(localStorage.getItem(UID_KEY)).toBe("U2");
	});

	it("アクセストークンが無いときは保存値を返す(起動直後・オフライン中)", () => {
		localStorage.setItem(UID_KEY, "U9");

		expect(authSession.accessToken).toBeNull();
		expect(authSession.userId).toBe("U9");
	});

	it("壊れたトークンでは投げずにnullを返す", () => {
		expect(() => authSession.setTokens("not-a-jwt", "refresh-1")).not.toThrow();
		expect(authSession.userId).toBeNull();
		authSession.setTokens("a.%%%.c", null);
		expect(authSession.userId).toBeNull();
	});

	it("clearはlatch.uidも消す", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");

		authSession.clear();

		expect(authSession.userId).toBeNull();
		expect(localStorage.getItem(UID_KEY)).toBeNull();
	});
});

describe("authSession.offline", () => {
	it("通信失敗のrestoreでオフライン中のセッションになり・続くrestoreの成功で解ける", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		localStorage.setItem(UID_KEY, "U1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));

		await expect(authSession.restore()).resolves.toBe(false);

		expect(authSession.offline).toBe(true);
		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1");
		expect(authSession.userId).toBe("U1");

		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: fakeJwt({ sub: "U1" }),
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);
		await expect(authSession.restore()).resolves.toBe(true);

		expect(authSession.offline).toBe(false);
	});

	it("拒否(401)のrestoreでオフラインを解き・保存値を消し・onClearを1回呼ぶ", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		localStorage.setItem(UID_KEY, "U1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await authSession.restore();
		expect(authSession.offline).toBe(true);

		const listener = vi.fn();
		const off = authSession.onClear(listener);
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		await expect(authSession.restore()).resolves.toBe(false);

		expect(authSession.offline).toBe(false);
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
		expect(localStorage.getItem(UID_KEY)).toBeNull();
		expect(listener).toHaveBeenCalledTimes(1);
		off();
	});

	it("保存が無いrestoreではオフラインにならない", async () => {
		await authSession.restore();

		expect(authSession.offline).toBe(false);
	});

	it("setTokensでオフラインを解く(サインインし直したら復元の再試行は不要)", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await authSession.restore();
		expect(authSession.offline).toBe(true);

		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-2");

		expect(authSession.offline).toBe(false);
	});

	it("refreshの成功でもオフラインを解く", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await authSession.restore();
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: fakeJwt({ sub: "U1" }),
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		await expect(authSession.refresh()).resolves.toBe(true);

		expect(authSession.offline).toBe(false);
	});

	it("clearでオフラインを解く", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await authSession.restore();

		authSession.clear();

		expect(authSession.offline).toBe(false);
	});
});

describe("authSession.onClear", () => {
	it("解除したlistenerは呼ばれない", () => {
		const listener = vi.fn();
		const off = authSession.onClear(listener);
		off();

		authSession.clear();

		expect(listener).not.toHaveBeenCalled();
	});

	it("投げるlistenerがあっても破棄を終え・他のlistenerも呼ぶ", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const throwing = authSession.onClear(() => {
			throw new Error("失敗");
		});
		const other = vi.fn();
		const offOther = authSession.onClear(other);

		expect(() => authSession.clear()).not.toThrow();

		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
		expect(other).toHaveBeenCalledTimes(1);
		throwing();
		offOther();
	});

	it("logoutの最後にlistenerを呼ぶ", async () => {
		authSession.setTokens("access-1", "refresh-1");
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const listener = vi.fn();
		const off = authSession.onClear(listener);

		await authSession.logout();

		expect(listener).toHaveBeenCalledTimes(1);
		off();
	});
});

describe("authSession.refreshOutcome", () => {
	it("通信失敗はnetwork_error・明示拒否はrejected・成功はsuccessを返す", async () => {
		localStorage.setItem(REFRESH_KEY, "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await expect(authSession.refreshOutcome()).resolves.toBe("network_error");

		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: fakeJwt({ sub: "U1" }),
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);
		await expect(authSession.refreshOutcome()).resolves.toBe("success");

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
		await expect(authSession.refreshOutcome()).resolves.toBe("rejected");
	});
});

describe("authSession.onUserChange", () => {
	it("U1→U2のsetTokensで1回だけ呼ぶ", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const listener = vi.fn();
		const off = authSession.onUserChange(listener);

		authSession.setTokens(fakeJwt({ sub: "U2" }), "refresh-2");
		off();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(authSession.userId).toBe("U2");
	});

	it("同じ利用者(U1→U1)では呼ばない", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const listener = vi.fn();
		const off = authSession.onUserChange(listener);

		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-2");
		off();

		expect(listener).not.toHaveBeenCalled();
	});

	it("保存された利用者IDが無い初回のサインインでは呼ばない", () => {
		const listener = vi.fn();
		const off = authSession.onUserChange(listener);

		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		off();

		expect(listener).not.toHaveBeenCalled();
	});

	it("新しいトークンのsubが読めず・前の利用者IDがあったときも呼ぶ", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const listener = vi.fn();
		const off = authSession.onUserChange(listener);

		authSession.setTokens("broken", "refresh-2");
		off();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("listenerが投げてもトークンの更新は済み・他のlistenerも呼ぶ", () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const second = vi.fn();
		const offA = authSession.onUserChange(() => {
			throw new Error("boom");
		});
		const offB = authSession.onUserChange(second);
		const next = fakeJwt({ sub: "U2" });

		expect(() => authSession.setTokens(next, "refresh-2")).not.toThrow();
		offA();
		offB();

		expect(authSession.accessToken).toBe(next);
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-2");
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("リフレッシュで利用者が変わったときも呼ぶ", async () => {
		authSession.setTokens(fakeJwt({ sub: "U1" }), "refresh-1");
		const listener = vi.fn();
		const off = authSession.onUserChange(listener);
		fetchMock.mockResolvedValueOnce(
			jsonResponse(200, {
				access_token: fakeJwt({ sub: "U2" }),
				refresh_token: "refresh-2",
				expires_in: 3600,
			}),
		);

		await authSession.refresh();
		off();

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
