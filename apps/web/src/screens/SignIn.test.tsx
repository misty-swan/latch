/**
 * SignIn画面(ボード: SignIn.dc.html)の単体試験。
 * Google/Appleボタン・18歳の注意文言がボードどおりであることと、
 * dev専用テストサインインの開閉・本番相当では未実装の旨を確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.signin],
	});
	render(<RouterProvider router={router} />);
	return router;
};

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
});

describe("SignIn", () => {
	it("ボードどおりのコピーと導線を持つ", () => {
		const router = setup();

		expect(screen.getByText("はじめに、アカウントをつくります。")).toBeTruthy();
		expect(
			screen.getByText(
				"ログインには、GoogleかAppleのアカウントを使います。LATCHでパスワードを作ることはありません。",
			),
		).toBeTruthy();
		expect(
			screen.getByText("LATCHは18歳以上の方がご利用いただけます。続けると、", {
				exact: false,
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "利用規約" }).getAttribute("href"),
		).toBe(PATHS.terms);
		expect(
			screen
				.getByRole("link", { name: "プライバシーポリシー" })
				.getAttribute("href"),
		).toBe(PATHS.privacy);

		fireEvent.click(screen.getByRole("button", { name: "Googleで続ける" }));
		fireEvent.click(screen.getByRole("button", { name: "Appleで続ける" }));

		fireEvent.click(screen.getByRole("link", { name: "戻る" }));
		expect(router.state.location.pathname).toBe(PATHS.intro);
	});

	it("devでは・Googleボタンからテストサインイン(名前入力)へ進める", () => {
		setup();

		fireEvent.click(screen.getByRole("button", { name: "Googleで続ける" }));

		expect(screen.getByLabelText("名前")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "テストではじめる" }),
		).toBeTruthy();
	});

	it("本番相当(DEV=false)では・押しても未実装である旨を示す", () => {
		vi.stubEnv("DEV", false);
		setup();

		fireEvent.click(screen.getByRole("button", { name: "Googleで続ける" }));

		expect(
			screen.getByText("Google/Appleでのサインインは準備中です。"),
		).toBeTruthy();
		expect(screen.queryByLabelText("名前")).toBeNull();
	});

	it("戻るはintroの3/3(届く)へ戻る(ボードの導線どおり)", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "戻る" }));

		expect(router.state.location.pathname).toBe(PATHS.intro);
		expect(router.state.location.search).toBe("?step=3");
		expect(screen.getByText("03 — 届く")).toBeTruthy();
	});
});
