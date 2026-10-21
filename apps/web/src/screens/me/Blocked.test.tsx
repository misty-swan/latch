/** /settings/blocked(Blocked・F7c設計 §1.6)の単体試験 */

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

let blocks: unknown[];
let deleteResult: () => Promise<Response>;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/blocks") return json({ blocks });
		if (url === "/v1/users/u9/block" && init?.method === "DELETE") {
			return deleteResult();
		}
		if (url.startsWith("/v1/notifications")) {
			return json({ items: [], next_cursor: null, unread_count: 0 });
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const setup = () => {
	authSession.setTokens("access-1", "refresh-1");
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.blocked],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

const row = {
	user_id: "u9",
	display_name: "ミナト",
	has_icon: false,
	created_at: "2026-10-02T03:00:00.000Z",
};

beforeEach(() => {
	blocks = [row];
	deleteResult = async () => json(null, 204);
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

describe("Blocked", () => {
	it("行に表示名・ブロックした日(JST)・注記を出す", async () => {
		setup();
		expect(await screen.findByText("ミナト")).toBeTruthy();
		expect(screen.getByText("10月2日にブロック")).toBeTruthy();
		expect(
			screen.getByText(
				"解除すると、また提案が届くことがあります。以前に提案された相手との提案は、解除後も届きません。",
			),
		).toBeTruthy();
	});

	it("[解除]でDELETEし・一覧を取り直す", async () => {
		setup();
		await screen.findByText("ミナト");
		blocks = [];
		fireEvent.click(screen.getByRole("button", { name: "解除" }));
		expect(
			await screen.findByText("ブロックしたユーザーはいません。"),
		).toBeTruthy();
		const calls = fetchMock.mock.calls.map(
			([u, i]) => `${i?.method ?? "GET"} ${u}`,
		);
		expect(calls).toContain("DELETE /v1/users/u9/block");
		expect(calls.filter((c) => c === "GET /v1/blocks").length).toBe(2);
	});

	it("0件では案内を出す", async () => {
		blocks = [];
		setup();
		expect(
			await screen.findByText("ブロックしたユーザーはいません。"),
		).toBeTruthy();
	});

	it("解除の失敗では画面に留まり・注意を出し・解除中は押せない", async () => {
		let reject: (r: Response) => void = () => {};
		deleteResult = () => new Promise<Response>((r) => (reject = r));
		const router = setup();
		await screen.findByText("ミナト");
		const button = screen.getByRole("button", {
			name: "解除",
		}) as HTMLButtonElement;
		fireEvent.click(button);
		await waitFor(() => expect(button.disabled).toBe(true));
		reject(
			json({ error: { code: "INTERNAL", message: "x", request_id: "r" } }, 500),
		);
		expect(
			await screen.findByText(
				"送れませんでした。時間をおいて、もう一度お試しください。",
			),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.blocked);
		expect(screen.getByText("ミナト")).toBeTruthy();
		expect(button.disabled).toBe(false);
	});
});
