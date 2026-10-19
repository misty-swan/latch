import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { ApiError, apiFetch } from "./client";

/** localStorageのキー(authSessionと共有) */
const REFRESH_KEY = "latch.refresh";

/** JSON応答のResponseを作る */
const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** docs/05 §3.1のエラー形状のResponseを作る */
const errorResponse = (
	status: number,
	code: string,
	message: string,
	details: Record<string, unknown> = {},
): Response => jsonResponse(status, { error: { code, message, details } });

/** fetchのモック(実APIは叩かない) */
const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

/** 突き合わせを楽にするためのPromise結果取り出し */
const settle = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		(value) => value,
		(error: unknown) => error,
	);

describe("apiFetch", () => {
	it("200のJSONをデシリアライズして返し・Bearerを自動付与する", async () => {
		authSession.setTokens("access-1", "refresh-1");
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "u1" }));

		await expect(apiFetch("/users/me")).resolves.toEqual({ id: "u1" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/users/me");
		expect((init.headers as Headers).get("Authorization")).toBe(
			"Bearer access-1",
		);
	});

	it("jsonを指定するとJSONボディとContent-Typeで送る", async () => {
		authSession.setTokens("access-1", null);
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "i1" }));

		await expect(
			apiFetch("/intents", { method: "POST", json: { raw_text: "テスト" } }),
		).resolves.toEqual({ id: "i1" });

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(init.body).toBe(JSON.stringify({ raw_text: "テスト" }));
		expect((init.headers as Headers).get("Content-Type")).toBe(
			"application/json",
		);
	});

	it("401 TOKEN_EXPIREDでリフレッシュ1回→同一リクエストを再試行する", async () => {
		authSession.setTokens("old-access", "refresh-1");
		fetchMock
			.mockResolvedValueOnce(
				errorResponse(401, "TOKEN_EXPIRED", "期限切れです"),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					access_token: "new-access",
					refresh_token: "refresh-2",
					expires_in: 3600,
				}),
			)
			.mockResolvedValueOnce(jsonResponse(200, { id: "u1" }));

		await expect(apiFetch("/users/me")).resolves.toEqual({ id: "u1" });

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const [refreshUrl, refreshInit] = fetchMock.mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(refreshUrl).toBe("/v1/auth/refresh");
		expect(JSON.parse(refreshInit.body as string)).toEqual({
			refresh_token: "refresh-1",
		});
		// 再試行は回転後のトークンで行う
		const retryHeaders = (fetchMock.mock.calls[2][1] as RequestInit)
			.headers as Headers;
		expect(retryHeaders.get("Authorization")).toBe("Bearer new-access");
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-2");
	});

	it("リフレッシュも失敗したらセッションを破棄し/welcomeへ遷移してApiErrorを投げる", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		authSession.setTokens("old-access", "refresh-1");
		fetchMock
			.mockResolvedValueOnce(
				errorResponse(401, "TOKEN_EXPIRED", "期限切れです"),
			)
			.mockResolvedValueOnce(
				errorResponse(401, "TOKEN_EXPIRED", "再ログインしてください"),
			);

		const caught = await settle(apiFetch("/users/me"));

		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).code).toBe("TOKEN_EXPIRED");
		expect(authSession.accessToken).toBeNull();
		expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
		expect(assign).toHaveBeenCalledWith("/welcome");
	});

	it("リフレッシュトークンが不在ならリフレッシュせず/welcomeへ遷移する", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		authSession.setTokens("old-access", null);
		fetchMock.mockResolvedValueOnce(
			errorResponse(401, "UNAUTHORIZED", "未認証です"),
		);

		const caught = await settle(apiFetch("/users/me"));

		expect(caught).toBeInstanceOf(ApiError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(authSession.accessToken).toBeNull();
		expect(assign).toHaveBeenCalledWith("/welcome");
	});

	it("再試行でも401なら再リフレッシュせずセッションを破棄して/welcomeへ遷移する", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		authSession.setTokens("old-access", "refresh-1");
		fetchMock
			.mockResolvedValueOnce(
				errorResponse(401, "UNAUTHORIZED", "失効しています"),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, {
					access_token: "new-access",
					refresh_token: "refresh-2",
					expires_in: 3600,
				}),
			)
			.mockResolvedValueOnce(
				errorResponse(401, "UNAUTHORIZED", "失効しています"),
			);

		const caught = await settle(apiFetch("/users/me"));

		expect(caught).toBeInstanceOf(ApiError);
		// 元リクエスト→リフレッシュ→再試行の3回で終わる(4回目以降の無限ループがない)
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(assign).toHaveBeenCalledWith("/welcome");
	});

	it("401以外のエラー形状はリフレッシュせずApiErrorになる", async () => {
		authSession.setTokens("access-1", "refresh-1");
		fetchMock.mockResolvedValueOnce(
			errorResponse(422, "PARSE_FAILED", "読み解けませんでした", {
				hint: "具体的に",
			}),
		);

		const caught = await settle(apiFetch("/intents/parse", { method: "POST" }));

		expect(caught).toBeInstanceOf(ApiError);
		const error = caught as ApiError;
		expect(error.code).toBe("PARSE_FAILED");
		expect(error.message).toBe("読み解けませんでした");
		expect(error.details).toEqual({ hint: "具体的に" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("JSONでないエラー応答はINTERNALのApiErrorになる", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("<html>gateway error</html>", { status: 502 }),
		);

		const caught = await settle(apiFetch("/users/me"));

		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).code).toBe("INTERNAL");
	});

	it("204はundefinedを返す", async () => {
		authSession.setTokens("access-1", "refresh-1");
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

		await expect(
			apiFetch("/auth/logout", { method: "POST" }),
		).resolves.toBeUndefined();
	});
});
