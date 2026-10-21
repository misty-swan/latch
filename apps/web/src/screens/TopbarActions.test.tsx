/**
 * TopbarActions(右上のお知らせと自分の入口・F7c設計)の単体試験。
 * 未読0/未読ありのラベルと点・遷移先を確かめる
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { createTestQueryClient } from "../test/helpers";
import { TopbarActions } from "./TopbarActions";

const json = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

let unread = 0;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.startsWith("/v1/notifications")) {
		return json({ items: [], next_cursor: null, unread_count: unread });
	}
	if (url === "/v1/users/me") {
		return json({ id: "u1", has_icon: false });
	}
	throw new Error(`想定外のfetch: ${url}`);
});

const open = () => {
	const router = createMemoryRouter([
		{ path: "/", element: <TopbarActions /> },
	]);
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	unread = 0;
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-topbar", null);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("TopbarActions", () => {
	it("未読0ではラベルが「お知らせ」で点が無い", async () => {
		open();
		const bell = await screen.findByRole("link", { name: "お知らせ" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(bell.querySelector(".dot")).toBeNull();
		expect(bell.getAttribute("href")).toBe("/notices");
	});

	it("未読3件ではラベルに件数が入り点が出る", async () => {
		unread = 3;
		open();
		const bell = await screen.findByRole("link", {
			name: "お知らせ(未読3件)",
		});
		expect(bell.querySelector(".dot")).not.toBeNull();
		expect(bell.getAttribute("href")).toBe("/notices");
	});

	it("自分のリンクは/meへ向かう", async () => {
		open();
		const me = await screen.findByRole("link", { name: "自分" });
		expect(me.getAttribute("href")).toBe("/me");
	});
});
