/**
 * /me/withdraw(Withdraw・LAT-94)の単体試験。確認の段の文言・やめる・再認証から退会までの流れ・
 * 失敗の表示を確かめる(試験はimport.meta.env.DEVのためdevの確かめに繋がる)。
 * 本番相当(DEV=false)では、サインインに使ったIdPのボタンを出し・押すとIdPの認可画面へ移ること
 * (移動はstartIdpRedirectを差し替えて確かめる・本物のIdPには接続しない)
 */

import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdpRedirect } from "../../auth/idp";
import { authSession } from "../../auth/session";
import { appRoutes } from "../../router";
import { PATHS } from "../../routes/paths";
import { createTestQueryClient } from "../../test/helpers";

vi.mock("../../auth/idp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../auth/idp")>()),
	startIdpRedirect: vi.fn(() => true),
}));

const json = (body: unknown, status = 200): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let withdrawResponse: () => Response;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/dev/idp-token") return json({ idp_token: "idp-1" });
		if (url === "/v1/users/me") return withdrawResponse();
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const setup = (state?: unknown) => {
	authSession.setTokens("access-1", "refresh-1");
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.me, { pathname: PATHS.withdraw, state }],
		initialIndex: 1,
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

const confirmAs = (name: string) => {
	fireEvent.click(
		screen.getByRole("button", { name: "Googleで確かめて退会する" }),
	);
	fireEvent.change(screen.getByLabelText("サインインに使った名前"), {
		target: { value: name },
	});
	fireEvent.click(screen.getByRole("button", { name: "確かめて退会する" }));
};

beforeEach(() => {
	withdrawResponse = () => json(null, 204);
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	authSession.clear();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.mocked(startIdpRedirect).mockClear();
});

describe("Withdraw", () => {
	it("確認の段: 削除されるもの・相手の側に残るもの・再認証の予告をボードどおりに出す", () => {
		setup();

		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"退会の前に。",
		);
		for (const text of [
			"退会すると、次のものが削除されます。元には戻せません。",
			"預けた意思と、その読み解き結果",
			"プロフィールとアイコン",
			"提案の履歴",
			"つながりのメッセージは、相手の側に残ります。あなたの名前とアイコンは、相手の側にも表示されなくなります。",
			"退会の前に、もう一度ログインして本人であることを確かめます。",
		]) {
			expect(screen.getByText(text)).toBeTruthy();
		}
		expect(
			screen.getByRole("button", { name: "Googleで確かめて退会する" }),
		).toBeTruthy();
		expect(screen.getByText("やめる").closest("a")?.getAttribute("href")).toBe(
			"/me",
		);
		// 押すまでは何も呼ばない(確認の段)
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("確かめるとIdPトークンを添えてDELETE /v1/users/meを呼び、端末のセッションを捨てて/welcomeで「退会しました。」を出す", async () => {
		const router = setup();

		confirmAs("みなと");

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/welcome"),
		);
		const idp = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/dev/idp-token",
		);
		expect(JSON.parse(String(idp?.[1]?.body))).toEqual({ subject: "みなと" });
		const del = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/users/me",
		);
		expect(del?.[1]?.method).toBe("DELETE");
		expect(JSON.parse(String(del?.[1]?.body))).toEqual({
			provider: "google",
			idp_token: "idp-1",
		});
		expect(await screen.findByText("退会しました。")).toBeTruthy();
		expect(localStorage.getItem("latch.refresh")).toBeNull();
		expect(authSession.accessToken).toBeNull();
		// ログアウトのAPIは呼ばない(トークンは退会の処理で失効している)
		expect(
			fetchMock.mock.calls.some(([u]) => String(u) === "/v1/auth/logout"),
		).toBe(false);
	});

	it("本人確認に失敗したら(403)、その場に理由を出してセッションは残す", async () => {
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
		const router = setup();

		confirmAs("別の名前");

		expect((await screen.findByRole("alert")).textContent).toBe(
			"本人であることを確かめられませんでした。もう一度お試しください",
		);
		expect(router.state.location.pathname).toBe(PATHS.withdraw);
		expect(authSession.accessToken).toBe("access-1");
		expect(
			screen.getByRole("button", { name: "確かめて退会する" }),
		).toHaveProperty("disabled", false);
	});

	describe("本番相当(DEV=false)", () => {
		beforeEach(() => {
			vi.stubEnv("DEV", false);
			vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "google-client");
			vi.stubEnv("VITE_APPLE_CLIENT_ID", "jp.example.latch.web");
		});

		it("Appleで入った人には「Appleで確かめて退会する」だけを出し、押すとAppleの認可画面へ移る", () => {
			authSession.setProvider("apple");
			setup();

			expect(
				screen.queryByRole("button", { name: "Googleで確かめて退会する" }),
			).toBeNull();
			fireEvent.click(
				screen.getByRole("button", { name: "Appleで確かめて退会する" }),
			);

			expect(startIdpRedirect).toHaveBeenCalledWith("apple", "withdraw");
			expect(screen.queryByLabelText("サインインに使った名前")).toBeNull();
		});

		it("使ったIdPが分からなければ、client idのあるIdPのボタンを並べる", () => {
			vi.stubEnv("VITE_APPLE_CLIENT_ID", "");
			setup();

			fireEvent.click(
				screen.getByRole("button", { name: "Googleで確かめて退会する" }),
			);
			expect(
				screen.queryByRole("button", { name: "Appleで確かめて退会する" }),
			).toBeNull();
			expect(startIdpRedirect).toHaveBeenCalledWith("google", "withdraw");
		});

		it("使ったIdPのclient idが無ければ、ボタンを出さずに確認できない旨を示す", () => {
			vi.stubEnv("VITE_APPLE_CLIENT_ID", "");
			authSession.setProvider("apple");
			setup();

			expect(
				screen.queryByRole("button", { name: /で確かめて退会する$/ }),
			).toBeNull();
			expect(
				screen.getByText(
					"いまは本人の確認ができません。時間をおいてお試しください。",
				),
			).toBeTruthy();
		});

		it("IdPの戻りで失敗したときは、渡された一言を出す", () => {
			setup({
				idpError:
					"本人であることを確かめられませんでした。もう一度お試しください",
			});

			expect(screen.getByRole("alert").textContent).toBe(
				"本人であることを確かめられませんでした。もう一度お試しください",
			);
		});
	});
});
