/**
 * /notices(Notices・F7c設計)の単体試験。4種の行・遷移先・期限表示・既読の1回送信・
 * 空状態・[さらに表示]・[もう一度預ける]を確かめる
 */

import type { NotificationDTO } from "@latch/shared";
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
import { createTestQueryClient } from "../../test/helpers";

const id = (c: string) => c.repeat(26);
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const items: NotificationDTO[] = [
	{
		id: id("A"),
		type: "proposal",
		latch_id: id("1"),
		response_deadline: at(3_600_000),
		read_at: null,
		created_at: at(-60_000),
	},
	{
		id: id("B"),
		type: "matched",
		latch_id: id("2"),
		display_names: ["ミナト", "ソラ"],
		read_at: null,
		created_at: at(-120_000),
	},
	{
		id: id("C"),
		type: "closed",
		latch_id: id("3"),
		read_at: at(-1000),
		created_at: at(-180_000),
	},
	{
		id: id("D"),
		type: "intent_expired",
		intent: { id: id("4"), raw_text: "週末に桜島を走りたい" },
		read_at: at(-1000),
		created_at: at(-240_000),
	},
];

const json = (body: unknown, status = 200): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let pages: Record<string, unknown>;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/notifications/read" && init?.method === "POST") {
			return json(null, 204);
		}
		if (url.startsWith("/v1/notifications")) {
			const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
			return json(pages[cursor]);
		}
		if (url === "/v1/users/me") return json({ id: "u1", has_icon: false });
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const open = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: ["/notices"],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

const readCalls = () =>
	fetchMock.mock.calls.filter((c) => String(c[0]) === "/v1/notifications/read");

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-notices", null);
	sessionStorage.clear();
	pages = { "": { items, next_cursor: null, unread_count: 2 } };
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("Notices", () => {
	it("4種の行と遷移先・未読の印を出す", async () => {
		open();
		const proposal = await screen.findByRole("link", {
			name: /提案が届いています/,
		});
		expect(proposal.getAttribute("href")).toBe(`/latches/${id("1")}`);
		expect(proposal.className).toContain("is-unread");
		const matched = screen.getByRole("link", {
			name: /ミナト・ソラさんとつながりました/,
		});
		expect(matched.getAttribute("href")).toBe(`/latches/${id("2")}/chat`);
		expect(
			screen.queryByRole("link", { name: /この提案は成立しませんでした/ }),
		).toBeNull();
		const closed = screen.getByText("この提案は成立しませんでした");
		expect(closed.closest(".notice")?.className).not.toContain("is-unread");
		expect(screen.getByText("預けていた意思の期限が切れました")).toBeTruthy();
		expect(screen.getByText("週末に桜島を走りたい")).toBeTruthy();
	});

	it("期限内の提案だけ回答期限を出す", async () => {
		pages = {
			"": {
				items: [
					items[0],
					{
						...items[0],
						id: id("E"),
						response_deadline: at(-3_600_000),
					},
				],
				next_cursor: null,
				unread_count: 0,
			},
		};
		open();
		await screen.findAllByText("提案が届いています");
		expect(screen.getAllByText(/回答期限 .* まで/)).toHaveLength(1);
	});

	it("空のときは案内を出す", async () => {
		pages = { "": { items: [], next_cursor: null, unread_count: 0 } };
		open();
		expect(
			await screen.findByText("お知らせは、まだありません。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"提案が届いたときや、期限が来たときに、ここでお伝えします。",
			),
		).toBeTruthy();
		expect(readCalls()).toHaveLength(0);
	});

	it("既読は先頭のidで1回だけ送る(再描画・2頁目で再送しない)", async () => {
		pages = {
			"": { items, next_cursor: "cur2", unread_count: 2 },
			cur2: {
				items: [{ ...items[2], id: id("0") }],
				next_cursor: null,
				unread_count: 2,
			},
		};
		open();
		await screen.findByText("提案が届いています");
		await waitFor(() => expect(readCalls()).toHaveLength(1));
		expect(JSON.parse(String(readCalls()[0]?.[1]?.body))).toEqual({
			up_to_id: id("A"),
		});
		fireEvent.click(screen.getByRole("button", { name: "さらに表示" }));
		await waitFor(() =>
			expect(screen.getAllByText("この提案は成立しませんでした")).toHaveLength(
				2,
			),
		);
		expect(readCalls()).toHaveLength(1);
	});

	it("[もう一度預ける]で文章を持って作成画面へ", async () => {
		const router = open();
		fireEvent.click(
			await screen.findByRole("button", { name: "もう一度預ける" }),
		);
		expect(router.state.location.pathname).toBe("/compose");
		const saved = JSON.parse(sessionStorage.getItem("latch.compose") ?? "{}");
		expect(saved.raw_text).toBe("週末に桜島を走りたい");
		expect(saved.draft_id).toBeNull();
	});
});
