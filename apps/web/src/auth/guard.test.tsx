/**
 * RequireAuth(未認証ガード)の単体試験。
 * アクセストークンがあるとき・オフライン中のセッションのときは子を描画し、
 * どちらも無いときはwelcomeへ送ることを確かめる(fetchはモック)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATHS } from "../routes/paths";
import { RequireAuth } from "./guard";
import { authSession } from "./session";

const fetchMock = vi.fn();

const renderGuard = (): void => {
	const router = createMemoryRouter(
		[
			{
				path: "/protected",
				element: (
					<RequireAuth>
						<p>保護画面</p>
					</RequireAuth>
				),
			},
			{ path: PATHS.welcome, element: <p>ようこそ</p> },
		],
		{ initialEntries: ["/protected"] },
	);
	render(<RouterProvider router={router} />);
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	authSession.clear();
	vi.unstubAllGlobals();
});

describe("RequireAuth", () => {
	it("アクセストークンがあれば子を描画する", () => {
		authSession.setTokens("access-1", "refresh-1");

		renderGuard();

		expect(screen.getByText("保護画面")).toBeTruthy();
	});

	it("オフライン中のセッションでも子を描画する", async () => {
		localStorage.setItem("latch.refresh", "refresh-1");
		fetchMock.mockRejectedValueOnce(new TypeError("network down"));
		await authSession.restore();
		expect(authSession.offline).toBe(true);

		renderGuard();

		expect(screen.getByText("保護画面")).toBeTruthy();
	});

	it("どちらも無いときはwelcomeへ送る", () => {
		renderGuard();

		expect(screen.getByText("ようこそ")).toBeTruthy();
		expect(screen.queryByText("保護画面")).toBeNull();
	});
});
