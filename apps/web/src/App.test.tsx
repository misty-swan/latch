import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { authSession } from "./auth/session";
import { appRoutes } from "./router";
import { PATHS } from "./routes/paths";

/** homeの一覧取得(Task 6)は空で返す(未認証試験では呼ばれない) */
const fetchMock = vi.fn(
	async (): Promise<Response> =>
		new Response(JSON.stringify({ items: [], next_cursor: null }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

describe("App", () => {
	it("起動時にwelcome画面(はじめる導線)を表示する", async () => {
		render(<App />);

		expect(await screen.findByRole("link", { name: "はじめる" })).toBeTruthy();
	});

	it("PATHSに全画面のパスが定義されている", () => {
		expect(Object.values(PATHS)).toEqual([
			"/welcome",
			"/intro",
			"/signin",
			"/register",
			"/consent",
			"/compose",
			"/reading",
			"/confirm",
			"/parse-failed",
			"/placed",
			"/home",
			"/latches/:id",
			"/latches/:id/shelved",
			"/connections",
			"/latches/:id/chat",
		]);
	});

	it("未認証で保護画面(home)へ直行するとwelcomeへ戻される", async () => {
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [PATHS.home],
		});

		render(<App router={router} />);

		expect(await screen.findByRole("link", { name: "はじめる" })).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.welcome);
	});

	it("認証済みならhome(預けている)を表示する", async () => {
		authSession.setTokens("access-1", "refresh-1");
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [PATHS.home],
		});

		render(<App router={router} />);

		// 一覧は空(空状態)で・homeに留まる
		expect(
			await screen.findByRole("heading", {
				name: "まだ、何も置いていません。",
			}),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.home);
	});
});
