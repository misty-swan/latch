/**
 * /latches/:id/shelved(ShelvedScreen・F4c設計 §1.1・§1.3)の単体試験。
 * 見送っていない本人は/latches/:idへ置き換え・見送った本人には見送った画面を出し・
 * 理由を送れることを確かめる
 */

import type { LatchDTO } from "@latch/shared";
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
import { withQueryClient } from "../../test/helpers";

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO => ({
	id: "L1",
	form: "connection",
	status: "rejected",
	response_deadline: new Date(Date.now() + 3_600_000).toISOString(),
	participants_count: 2,
	my_response: "defer",
	score: 0.5,
	my_intent_id: "i1",
	matched_at: null,
	...over,
});

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let getLatch: LatchDTO;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (method === "GET" && url === "/v1/latches/L1") {
			return jsonResponse(200, getLatch);
		}
		if (method === "POST" && url === "/v1/latches/L1/defer-reason") {
			return jsonResponse(200, getLatch);
		}
		if (method === "GET") {
			return jsonResponse(200, { items: [], next_cursor: null });
		}
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: ["/latches/L1/shelved"],
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("matchMedia", (media: string) => ({
		matches: true,
		media,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
	authSession.setTokens("access-shelved", null);
	getLatch = latchOf();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

describe("ShelvedScreen", () => {
	it("見送っていない提案は/latches/:idへ置き換える", async () => {
		getLatch = latchOf({ status: "partial_accept", my_response: "yes" });
		const router = setup();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1"),
		);
		expect(await screen.findByText("回答を取り消す")).toBeTruthy();
	});

	it("deferなら見送った画面を出し・理由を送れる", async () => {
		setup();
		expect(
			await screen.findByText(
				"今回の提案は見送りました。あなたの意思は、そのまま預けています。",
			),
		).toBeTruthy();
		// 縦書きは文字ごとに分かれるため本文全体で見る
		expect(document.body.textContent?.replace(/\s/g, "")).toContain(
			"そっと、棚に戻しました。",
		);
		fireEvent.click(screen.getByRole("button", { name: /見送った理由を残す/ }));
		fireEvent.click(screen.getByLabelText("いまは余裕がない"));
		fireEvent.click(screen.getByRole("button", { name: "残す" }));
		await waitFor(() => {
			const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
			expect(post?.[1]?.body).toBe(JSON.stringify({ reason: "no_capacity" }));
		});
	});
});
