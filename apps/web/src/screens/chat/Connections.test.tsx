/**
 * /connections(Connections・F6b設計 §1.2)の単体試験。
 * 2区分への振り分け・終了の名前・未読・空状態・[さらに表示]・行のリンク先を確かめる
 */

import type { LatchDTO } from "@latch/shared";
import {
	IsRestoringProvider,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../../auth/session";
import { CONNECTIONS_QUERY_KEY } from "../../chat/queries";
import { appRoutes } from "../../router";
import { createTestQueryClient } from "../../test/helpers";
import { restoreOnline, setOnline } from "../../test/offline";

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO => ({
	id: "L1",
	form: "connection",
	status: "matched",
	response_deadline: new Date().toISOString(),
	participants_count: 2,
	my_response: "yes",
	score: 0.9,
	my_intent_id: "i1",
	matched_at: new Date().toISOString(),
	proposal: {
		form: "connection",
		topic: "絵を見せ合う",
		time_window: null,
		region_name: null,
		budget: null,
	} as LatchDTO["proposal"],
	members: [
		{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
	],
	...over,
});

const json = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

let pages: Record<string, unknown>;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.startsWith("/v1/latches?type=matched")) {
		const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
		return json(pages[cursor]);
	}
	if (url.startsWith("/v1/notifications")) {
		return json({ items: [], next_cursor: null, unread_count: 0 });
	}
	if (url === "/v1/users/me") return json({ id: "u1", has_icon: false });
	throw new Error(`想定外のfetch: ${url}`);
});

const open = (state?: unknown, client = createTestQueryClient()) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [{ pathname: "/connections", state }],
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-conn", null);
});
afterEach(() => {
	restoreOnline();
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("Connections", () => {
	it("遷移の state.toast をトーストに出し・state は消す", async () => {
		pages = { "": { items: [], next_cursor: null } };
		open({ toast: "一覧から消しました。" });
		expect(await screen.findByText("一覧から消しました。")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("一覧から消しました。");
	});

	it("matched・completed・cancelledを「つながっている」「終了」に分け・cancelledは実名を出さない", async () => {
		pages = {
			"": {
				items: [
					latchOf({ id: "L1" }),
					latchOf({ id: "L2", status: "completed" }),
					latchOf({ id: "L3", status: "cancelled" }),
				],
				next_cursor: null,
			},
		};
		open();
		const active = await screen.findByRole("heading", {
			name: "つながっている",
		});
		const ended = screen.getByRole("heading", { name: "終了" });
		const lists = screen.getAllByRole("list");
		expect(active.nextElementSibling).toBe(lists[0]);
		expect(ended.nextElementSibling).toBe(lists[1]);
		expect(within(lists[0] as HTMLElement).getAllByRole("link")).toHaveLength(
			1,
		);
		expect(within(lists[1] as HTMLElement).getAllByRole("link")).toHaveLength(
			2,
		);
		expect(screen.getByText("つながっていた相手")).toBeTruthy();
		expect(screen.getAllByText("ミナト")).toHaveLength(2);
		expect(screen.getAllByText("最初のひとことを送ってみましょう").length).toBe(
			3,
		);
	});

	it("行は/latches/L1/chatへのリンク・未読は件数つき", async () => {
		pages = {
			"": {
				items: [
					latchOf({
						unread_count: 2,
						last_message: {
							body: "こんにちは",
							created_at: new Date().toISOString(),
							user_id: "u2",
						},
					}),
				],
				next_cursor: null,
			},
		};
		open();
		const link = await screen.findByRole("link", { name: /ミナト/ });
		expect(link.getAttribute("href")).toBe("/latches/L1/chat");
		expect(screen.getByLabelText("未読2件")).toBeTruthy();
		expect(screen.getByText("こんにちは")).toBeTruthy();
	});

	it("0件なら空状態の文言", async () => {
		pages = { "": { items: [], next_cursor: null } };
		open();
		expect(
			await screen.findByText("まだ、つながりはありません。"),
		).toBeTruthy();
		expect(screen.queryByRole("heading", { name: "終了" })).toBeNull();
	});

	it("next_cursorがあれば[さらに表示]で2頁目を要求する", async () => {
		pages = {
			"": { items: [latchOf({ id: "L1" })], next_cursor: "c1" },
			c1: {
				items: [
					latchOf({
						id: "L9",
						members: [
							{
								user_id: "u9",
								display_name: "ハル",
								bio: null,
								has_icon: false,
							},
						],
					}),
				],
				next_cursor: null,
			},
		};
		open();
		fireEvent.click(await screen.findByRole("button", { name: "さらに表示" }));
		expect(await screen.findByText("ハル")).toBeTruthy();
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(([u]) => String(u).includes("cursor=c1")),
			).toBe(true),
		);
		expect(screen.queryByRole("button", { name: "さらに表示" })).toBeNull();
	});
});

describe("Connections(オフラインの帯)", () => {
	const BANNER = "オフラインです。最後に確かめた内容を表示しています。";

	it("オフライン中は帯を出す", async () => {
		pages = { "": { items: [latchOf()], next_cursor: null } };
		setOnline(false);
		open();
		expect(await screen.findByText(BANNER)).toBeTruthy();
	});

	it("オフラインで保存済みの一覧が無いときは、帯と読み込めなかった表示を出し、オンラインに戻ると一覧を出す", async () => {
		pages = { "": { items: [latchOf()], next_cursor: null } };
		setOnline(false);
		open();
		expect(await screen.findByText(BANNER)).toBeTruthy();
		expect(screen.getByText("一覧を読み込めませんでした。")).toBeTruthy();
		act(() => setOnline(true));
		expect(
			await screen.findByRole("heading", { name: "つながっている" }),
		).toBeTruthy();
		expect(screen.queryByText(BANNER)).toBeNull();
	});

	it("オフラインでも端末の保存を読み戻している間は、読み込めなかった表示を出さない", async () => {
		setOnline(false);
		const router = createMemoryRouter(appRoutes, {
			initialEntries: ["/connections"],
		});
		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<IsRestoringProvider value={true}>
					<RouterProvider router={router} />
				</IsRestoringProvider>
			</QueryClientProvider>,
		);
		expect(
			await screen.findByRole("heading", { name: "つながり" }),
		).toBeTruthy();
		expect(screen.queryByText("一覧を読み込めませんでした。")).toBeNull();
	});

	it("オンラインなら帯を出さない", async () => {
		pages = { "": { items: [latchOf()], next_cursor: null } };
		open();
		await screen.findByRole("heading", { name: "つながっている" });
		expect(screen.queryByText(BANNER)).toBeNull();
	});

	it("再取得がTypeErrorで失敗し、データがあるときは帯と一覧を出す", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 0 } },
		});
		client.setQueryData(CONNECTIONS_QUERY_KEY, {
			pages: [{ items: [latchOf()], next_cursor: null }],
			pageParams: [undefined],
		});
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith("/v1/latches?type=matched")) {
				throw new TypeError("network");
			}
			if (url.startsWith("/v1/notifications")) {
				return json({ items: [], next_cursor: null, unread_count: 0 });
			}
			return json({ id: "u1", has_icon: false });
		});
		open(undefined, client);
		expect(await screen.findByText(BANNER)).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "つながっている" }),
		).toBeTruthy();
	});
});
