import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { authSession } from "./auth/session";
import { appRoutes } from "./router";
import { PATHS } from "./routes/paths";

afterEach(() => {
	cleanup();
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

	it("認証済みならhomeのプレースホルダを表示する", async () => {
		authSession.setTokens("access-1", "refresh-1");
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [PATHS.home],
		});

		render(<App router={router} />);

		expect(await screen.findByText("home")).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.home);
	});
});
