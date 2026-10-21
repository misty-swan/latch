/**
 * /latches/:id/chat(Chat・F6b設計 §1.3)の単体試験。
 * 見出し・冒頭・終了の帯・振り分け(404/成立前)・古い履歴の読み込み
 */

import type { LatchDTO, MessageDTO } from "@latch/shared";
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

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "L1",
		form: "connection",
		status: "matched",
		response_deadline: "2026-10-30T00:00:00Z",
		participants_count: 2,
		my_response: "yes",
		score: 0.9,
		my_intent_id: "i1",
		matched_at: "2026-10-10T08:40:00Z",
		proposal: {
			form: "connection",
			topic: "絵を見せ合う",
			time_window: null,
			region_name: null,
			budget: null,
		},
		members: [
			{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
		],
		...over,
	}) as LatchDTO;

const msg = (id: string, user_id: string): MessageDTO => ({
	id,
	user_id,
	body: `本文${id}`,
	created_at: "2026-10-10T09:00:00Z",
	client_id: null,
});

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let latch: LatchDTO | "404";
let history: Record<string, unknown>;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === "/v1/users/me") return json({ id: "me" });
	if (url === "/v1/latches/L1") {
		return latch === "404"
			? json({ error: { code: "NOT_FOUND", message: "x" } }, 404)
			: json(latch);
	}
	if (url.startsWith("/v1/latches/L1/messages")) {
		const before = new URL(url, "http://x").searchParams.get("before") ?? "";
		return json(history[before]);
	}
	if (url === "/v1/latches/L1/read") return new Response(null, { status: 204 });
	throw new Error(`想定外のfetch: ${url}`);
});

const open = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: ["/latches/L1/chat"],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-chat", null);
	latch = latchOf();
	history = { "": { items: [msg("02", "me")], next_before: null } };
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("Chat", () => {
	it("見出しに名前と「主題·形式」・冒頭に成立時刻と人数・履歴を出す", async () => {
		open();
		expect(await screen.findByText("ミナト")).toBeTruthy();
		expect(document.querySelector(".chat-head__sub")?.textContent).toBe(
			"絵を見せ合う·つながり",
		);
		expect(screen.getByText("10月10日 17:40 につながりました")).toBeTruthy();
		expect(await screen.findByText("本文02")).toBeTruthy();
		expect(screen.getByLabelText("このつながりについて")).toBeTruthy();
		expect(screen.getByLabelText("戻る").getAttribute("href")).toBe(
			"/connections",
		);
		expect(document.querySelector(".ended-bar")).toBeNull();
	});

	it("機会は「主題·N人·場所」", async () => {
		latch = latchOf({
			form: "occasion",
			participants_count: 4,
			proposal: {
				form: "occasion",
				topic: "軽く飲みに行く",
				time_window: null,
				region_name: "天文館周辺",
				budget: null,
			} as LatchDTO["proposal"],
		});
		open();
		await screen.findByText("本文02");
		const cap = document.querySelector(".chat__origin .t-caption");
		expect(cap?.textContent).toBe("軽く飲みに行く·4人·天文館周辺");
	});

	it("completedは実名のまま終了の帯が出て入力欄が無い", async () => {
		latch = latchOf({ status: "completed" });
		open();
		expect(await screen.findByText("このつながりは終了しました")).toBeTruthy();
		expect(screen.getByText("ミナト")).toBeTruthy();
		expect(document.querySelector(".ended-bar")).not.toBeNull();
		expect(document.querySelector(".composer")).toBeNull();
	});

	it("cancelledは名前がつながっていた相手", async () => {
		latch = latchOf({ status: "cancelled" });
		open();
		expect(await screen.findByText("つながっていた相手")).toBeTruthy();
		expect(screen.queryByText("ミナト")).toBeNull();
		expect(document.querySelector(".avatar--gone")).not.toBeNull();
		expect(document.querySelector(".ended-bar")).not.toBeNull();
	});

	it("履歴の取得に失敗したら失敗表示と再読み込みが出て・成功すると履歴が出る", async () => {
		let failing = true;
		const base = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			if (failing && String(input).startsWith("/v1/latches/L1/messages")) {
				return json({ error: { code: "INTERNAL", message: "x" } }, 500);
			}
			return (base as (i: RequestInfo | URL) => Promise<Response>)(input);
		});
		open();
		const retry = await screen.findByRole("button", {
			name: "もう一度読み込む",
		});
		expect(screen.getByText("履歴を読み込めませんでした。")).toBeTruthy();
		failing = false;
		fetchMock.mockClear();
		fireEvent.click(retry);
		expect(await screen.findByText("本文02")).toBeTruthy();
		expect(
			fetchMock.mock.calls.some(([u]) =>
				String(u).startsWith("/v1/latches/L1/messages"),
			),
		).toBe(true);
		fetchMock.mockImplementation(base as never);
	});

	it("成立前(matched_atがnull)は/latches/L1へ置き換え遷移する", async () => {
		latch = latchOf({ status: "proposed", matched_at: null });
		const router = open();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1"),
		);
		expect(
			fetchMock.mock.calls.some(([u]) => String(u).includes("/messages")),
		).toBe(false);
	});

	it("404は/latches/L1へ置き換え遷移する", async () => {
		latch = "404";
		const router = open();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1"),
		);
	});

	it("上端の番兵が見えたら古い頁を読む(IntersectionObserver)", async () => {
		let fire: (() => void) | null = null;
		class FakeIO {
			constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
				fire = () => cb([{ isIntersecting: true }]);
			}
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("IntersectionObserver", FakeIO);
		history = {
			"": { items: [msg("05", "u2")], next_before: "05" },
			"05": { items: [msg("03", "u2")], next_before: null },
		};
		open();
		await screen.findByText("本文05");
		expect(
			screen.queryByRole("button", { name: "古いメッセージを読み込む" }),
		).toBeNull();
		(fire as (() => void) | null)?.();
		await screen.findByText("本文03");
	});

	it("[古いメッセージを読み込む]でbefore付きの要求・古い順に並ぶ", async () => {
		history = {
			"": { items: [msg("05", "u2")], next_before: "05" },
			"05": { items: [msg("03", "u2")], next_before: null },
		};
		vi.stubGlobal("IntersectionObserver", undefined);
		open();
		await screen.findByText("本文05");
		fireEvent.click(
			await screen.findByRole("button", { name: "古いメッセージを読み込む" }),
		);
		await screen.findByText("本文03");
		expect(
			fetchMock.mock.calls.some(([u]) =>
				String(u).includes("/messages?before=05"),
			),
		).toBe(true);
		const bodies = [...document.querySelectorAll(".msg__bubble")].map(
			(e) => e.textContent,
		);
		expect(bodies).toEqual(["本文03", "本文05"]);
		expect(
			screen.queryByRole("button", { name: "古いメッセージを読み込む" }),
		).toBeNull();
	});
});
