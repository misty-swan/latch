/** /me(Me・F7c設計)の単体試験。表示・導線・ログアウトを確かめる */

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
import { authSession } from "../../auth/session";
import { appRoutes } from "../../router";
import { PATHS } from "../../routes/paths";
import { createTestQueryClient } from "../../test/helpers";

const json = (body: unknown, status = 200): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let me: { id: string; display_name: string; bio: string; has_icon: boolean };
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/users/me") return json(me);
		if (url === "/v1/auth/logout") return json(null, 204);
		if (url.startsWith("/v1/notifications")) {
			return json({ items: [], next_cursor: null, unread_count: 0 });
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const setup = () => {
	authSession.setTokens("access-1", "refresh-1");
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.me],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

beforeEach(() => {
	me = {
		id: "U".repeat(26),
		display_name: "みなと",
		bio: "夜に散歩しています。",
		has_icon: false,
	};
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	authSession.clear();
	vi.unstubAllGlobals();
});

describe("Me", () => {
	it("表示名・ひとこと・説明と各導線(ヘルプ・お問い合わせと退会を含む)を出す", async () => {
		setup();

		expect(await screen.findByText("みなと")).toBeTruthy();
		expect(screen.getByText("夜に散歩しています。")).toBeTruthy();
		expect(
			screen.getByText(
				"このプロフィールは、つながった相手にだけ表示されます。",
			),
		).toBeTruthy();
		const href = (name: string) =>
			screen.getByText(name).closest("a")?.getAttribute("href");
		expect(href("プロフィールを編集")).toBe("/me/profile");
		expect(href("通知と表示")).toBe("/settings");
		expect(href("ブロックしたユーザー")).toBe("/settings/blocked");
		expect(href("外部送信と同意")).toBe("/consent?view=1");
		expect(href("利用規約")).toBe("/terms");
		expect(href("プライバシーポリシー")).toBe("/privacy");
		expect(href("ヘルプ・お問い合わせ")).toBe("/help");
		expect(href("退会する")).toBe("/me/withdraw");
		// 退会の行は注意の色(prototypeのlist-row--danger)で、ログアウトの後に置く
		const withdraw = screen.getByText("退会する").closest("a");
		expect(withdraw?.className).toContain("list-row--danger");
		const logout = screen.getByRole("button", { name: "ログアウト" });
		expect(
			logout.compareDocumentPosition(withdraw as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("ひとことが空なら「ひとことは未設定です」を出す", async () => {
		me.bio = "";
		setup();

		expect(await screen.findByText("ひとことは未設定です")).toBeTruthy();
	});

	it("[ログアウト]でrefresh_tokenを付けてAPIを呼び・トークンを消して/welcomeへ", async () => {
		const router = setup();
		await screen.findByText("みなと");

		fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/welcome"),
		);
		const call = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/auth/logout",
		);
		expect(call?.[1]?.method).toBe("POST");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			refresh_token: "refresh-1",
		});
		expect(localStorage.getItem("latch.refresh")).toBeNull();
		expect(authSession.accessToken).toBeNull();
	});
});
