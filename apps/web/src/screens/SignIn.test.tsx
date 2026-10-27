/**
 * SignIn画面(ボード: SignIn.dc.html)の単体試験。
 * Google/Appleボタン・18歳の注意文言がボードどおりであることと、
 * dev専用テストサインインの開閉と、本番相当(DEV=false)ではclient idのあるIdPのボタンだけを出し・
 * 押すとIdPの認可画面へ移ること(移動はstartIdpRedirectを差し替えて確かめる・本物のIdPには接続しない)
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startIdpRedirect } from "../auth/idp";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

vi.mock("../auth/idp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../auth/idp")>()),
	startIdpRedirect: vi.fn(() => true),
}));

const setup = (state?: unknown) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [{ pathname: PATHS.signin, state }],
	});
	render(<RouterProvider router={router} />);
	return router;
};

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.mocked(startIdpRedirect).mockClear();
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

	it("本番相当(DEV=false)でclient idが無ければ・ボタンを出さずにサインインできない旨を示す", () => {
		vi.stubEnv("DEV", false);
		vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
		vi.stubEnv("VITE_APPLE_CLIENT_ID", "");
		setup();

		expect(screen.queryByRole("button", { name: "Googleで続ける" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Appleで続ける" })).toBeNull();
		expect(
			screen.getByText(
				"いまはサインインできません。時間をおいてお試しください。",
			),
		).toBeTruthy();
	});

	it("本番相当でGoogleのclient idだけあれば・Googleだけを出し、押すとGoogleの認可画面へ移る", () => {
		vi.stubEnv("DEV", false);
		vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "google-client");
		vi.stubEnv("VITE_APPLE_CLIENT_ID", "");
		setup();

		expect(screen.queryByRole("button", { name: "Appleで続ける" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Googleで続ける" }));

		expect(startIdpRedirect).toHaveBeenCalledWith("google", "signin");
		expect(screen.queryByLabelText("名前")).toBeNull();
	});

	it("本番相当でAppleのclient idがあれば・押すとAppleの認可画面へ移る", () => {
		vi.stubEnv("DEV", false);
		vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "google-client");
		vi.stubEnv("VITE_APPLE_CLIENT_ID", "jp.example.latch.web");
		setup();

		fireEvent.click(screen.getByRole("button", { name: "Appleで続ける" }));

		expect(startIdpRedirect).toHaveBeenCalledWith("apple", "signin");
	});

	it("IdPの戻りで失敗したときは・渡された一言を出す", () => {
		vi.stubEnv("DEV", false);
		vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "google-client");
		setup({ idpError: "確かめられませんでした。もう一度お試しください" });

		expect(screen.getByRole("alert").textContent).toBe(
			"確かめられませんでした。もう一度お試しください",
		);
	});

	it("戻るはintroの3/3(届く)へ戻る(ボードの導線どおり)", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "戻る" }));

		expect(router.state.location.pathname).toBe(PATHS.intro);
		expect(router.state.location.search).toBe("?step=3");
		expect(screen.getByText("03 — 届く")).toBeTruthy();
	});
});
