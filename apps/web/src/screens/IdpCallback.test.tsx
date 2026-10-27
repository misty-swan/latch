/**
 * IdPの戻り先(/auth/callback・docs/04 §4)の単体試験。
 * 出発は差し替えたassignで行い(本物のIdPには接続しない)、戻りのURLの#以降を組み立てて描く。
 * サインインはPOST /v1/auth/token→登録/ホーム、退会はDELETE /v1/users/me→はじめの画面、
 * 失敗・取り消しは出発した画面へ戻ることを確かめる
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IdpPurpose, startIdpRedirect } from "../auth/idp";
import { authSession } from "../auth/session";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { createTestQueryClient } from "../test/helpers";

const json = (body: unknown, status = 200): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const fakeIdToken = (nonce: string): string => {
	const payload = btoa(JSON.stringify({ nonce }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
};

let tokenResponse: () => Response;
let withdrawResponse: () => Response;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/auth/token") return tokenResponse();
		if (url === "/v1/users/me") return withdrawResponse();
		throw new Error(`想定外のfetch: ${url}`);
	},
);

/** 出発して、IdPが返す#以降(stateとnonceを合わせたもの)を作る */
const departAndReturn = (
	provider: "google" | "apple",
	purpose: IdpPurpose,
	extra: Record<string, string> = {},
): { hash: string; idToken: string } => {
	const assign = vi.fn();
	startIdpRedirect(provider, purpose, assign);
	const url = new URL(String(assign.mock.calls[0]?.[0]));
	const idToken = fakeIdToken(url.searchParams.get("nonce") ?? "");
	const params = new URLSearchParams({
		state: url.searchParams.get("state") ?? "",
		id_token: idToken,
		...extra,
	});
	return { hash: `#${params.toString()}`, idToken };
};

const renderCallback = (hash: string) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [{ pathname: PATHS.idpCallback, hash }],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

const bodyOf = (url: string): unknown => {
	const call = fetchMock.mock.calls.find(([u]) => String(u) === url);
	return JSON.parse(String(call?.[1]?.body));
};

beforeEach(() => {
	vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "google-client");
	vi.stubEnv("VITE_APPLE_CLIENT_ID", "jp.example.latch.web");
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	sessionStorage.clear();
	localStorage.clear();
	authSession.clear();
	tokenResponse = () =>
		json({
			access_token: "access-pre",
			refresh_token: null,
			expires_in: 3600,
			user: null,
			registration_required: true,
		});
	withdrawResponse = () => json(null, 204);
});

afterEach(() => {
	cleanup();
	authSession.clear();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("IdpCallback", () => {
	it("サインイン: AppleのIDトークンでPOST /v1/auth/tokenを呼び、未登録なら登録へ進み、使ったIdPを記録する", async () => {
		const { hash, idToken } = departAndReturn("apple", "signin");
		const router = renderCallback(hash);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(PATHS.register),
		);
		expect(bodyOf("/v1/auth/token")).toEqual({
			provider: "apple",
			idp_token: idToken,
		});
		expect(authSession.accessToken).toBe("access-pre");
		expect(authSession.provider).toBe("apple");
		// IDトークンを履歴に残さない
		expect(window.location.hash).toBe("");
	});

	it("サインイン: 登録済みならホームへ進む", async () => {
		tokenResponse = () =>
			json({
				access_token: "access-1",
				refresh_token: "refresh-1",
				expires_in: 3600,
				user: { id: "u1", display_name: "ゆき", bio: null, has_icon: false },
				registration_required: false,
			});
		const { hash } = departAndReturn("google", "signin");
		const router = renderCallback(hash);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(PATHS.home),
		);
		expect(localStorage.getItem("latch.refresh")).toBe("refresh-1");
	});

	it("サインイン: サーバーが拒んだら(401)、サインインへ戻して理由を出す", async () => {
		tokenResponse = () =>
			json(
				{
					error: {
						code: "UNAUTHORIZED",
						message: "認証に失敗しました。もう一度お試しください",
						details: {},
					},
				},
				401,
			);
		const { hash } = departAndReturn("google", "signin");
		const router = renderCallback(hash);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"認証に失敗しました。もう一度お試しください",
		);
		expect(router.state.location.pathname).toBe(PATHS.signin);
	});

	it("取り消し: 一言を出さずにサインインへ戻す(APIは呼ばない)", async () => {
		const { hash } = departAndReturn("google", "signin", {
			error: "access_denied",
		});
		const router = renderCallback(hash);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(PATHS.signin),
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("出発していない戻りは、サインインへ戻して確かめられなかった旨を出す", async () => {
		const router = renderCallback("#state=x&id_token=y");

		expect((await screen.findByRole("alert")).textContent).toBe(
			"確かめられませんでした。もう一度お試しください",
		);
		expect(router.state.location.pathname).toBe(PATHS.signin);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("退会: IDトークンを添えてDELETE /v1/users/meを呼び、セッションを捨てて/welcomeで「退会しました。」を出す", async () => {
		authSession.setTokens("access-1", "refresh-1");
		authSession.setProvider("apple");
		const { hash, idToken } = departAndReturn("apple", "withdraw");
		const router = renderCallback(hash);

		expect(await screen.findByText("退会しました。")).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.welcome);
		expect(bodyOf("/v1/users/me")).toEqual({
			provider: "apple",
			idp_token: idToken,
		});
		expect(authSession.accessToken).toBeNull();
		expect(authSession.provider).toBeNull();
	});

	it("退会: 本人確認に失敗したら(403)、退会の画面へ戻して理由を出し、セッションは残す", async () => {
		withdrawResponse = () =>
			json(
				{
					error: {
						code: "FORBIDDEN",
						message:
							"本人であることを確かめられませんでした。もう一度お試しください",
						details: {},
					},
				},
				403,
			);
		authSession.setTokens("access-1", "refresh-1");
		const { hash } = departAndReturn("google", "withdraw");
		const router = renderCallback(hash);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"本人であることを確かめられませんでした。もう一度お試しください",
		);
		expect(router.state.location.pathname).toBe(PATHS.withdraw);
		expect(authSession.accessToken).toBe("access-1");
	});
});
