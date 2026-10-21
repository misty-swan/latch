/**
 * 内容を直す(/intents/:id/edit・F8a設計 §1.4)の試験(fetchはモック)
 */

import type { IntentDTO } from "@latch/shared";
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

const DAY = 24 * 3_600_000;
const ID = "01J00000000000000000000001";
const PATH = `/v1/intents/${ID}`;

const intentOf = (over: Partial<IntentDTO> = {}): IntentDTO => ({
	id: ID,
	form: "connection",
	topic: "絵を見せ合う",
	category: null,
	raw_text: "イラストを描く人と、月1くらいで絵を見せ合いたい。",
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	hard_constraints: [],
	soft_constraints: ["初心者"],
	negative_constraints: [],
	visibility: "hidden_until_match",
	notification_level: "proposals_only",
	alcohol_involved: false,
	status: "active",
	version: 1,
	expires_at: new Date(Date.now() + 18 * DAY).toISOString(),
	created_at: new Date(Date.now() - 12 * DAY).toISOString(),
	updated_at: new Date(Date.now() - 12 * DAY).toISOString(),
	...over,
});

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let intent: IntentDTO;
let patchResponse: () => Response | Promise<Response>;
const fetchMock = vi.fn(
	async (input: RequestInit | RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url === "/v1/users/me") return json({ id: "me" });
		if (url === PATH && method === "PATCH") return patchResponse();
		if (url === PATH) return json(intent);
		if (url.startsWith("/v1/intents?"))
			return json({ items: [intent], next_cursor: null });
		if (url.startsWith("/v1/latches?"))
			return json({ items: [], next_cursor: null });
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);
const patches = () =>
	fetchMock.mock.calls.filter(([, i]) => i?.method === "PATCH");
const gets = () =>
	fetchMock.mock.calls.filter(
		([u, i]) => String(u) === PATH && (i?.method ?? "GET") === "GET",
	);

const open = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [`/intents/${ID}/edit`],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

/** 主題を「新しい主題」へ直す */
const editTopic = async () => {
	fireEvent.click(await screen.findByLabelText("主題を直す"));
	const input = screen.getByLabelText("主題");
	fireEvent.change(input, { target: { value: "新しい主題" } });
	fireEvent.keyDown(input, { key: "Enter" });
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-edit", null);
	intent = intentOf();
	patchResponse = () => {
		intent = { ...intent, topic: "新しい主題", version: 2 };
		return json(intent);
	};
	sessionStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("IntentEdit", () => {
	it("初期値は意思の内容で、預け方・期限・地域は表示のみ(編集の入口が無い)", async () => {
		open();
		await screen.findByText("絵を見せ合う");
		expect(screen.getByText("初心者")).toBeTruthy();
		expect(screen.getByLabelText("主題を直す")).toBeTruthy();
		expect(screen.queryByLabelText("預け方")).toBeNull();
		expect(screen.queryByLabelText("期限")).toBeNull();
	});

	it("変更して保存すると確認を経てPATCHし、詳細へ戻りトーストを出す", async () => {
		const router = open();
		await editTopic();
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		expect(
			await screen.findByText("直すと、届いている提案は取り消されます。"),
		).toBeTruthy();
		expect(patches()).toHaveLength(0);
		const sheet = screen.getByRole("dialog");
		fireEvent.click(sheet.querySelector(".btn--primary") as HTMLButtonElement);
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(`/intents/${ID}`);
		});
		expect(patches()).toHaveLength(1);
		expect(JSON.parse(String(patches()[0]?.[1]?.body))).toEqual({
			topic: "新しい主題",
		});
		expect((await screen.findByRole("status")).textContent).toBe(
			"直しました。",
		);
	});

	it("確認の[やめる]ではPATCHしない", async () => {
		open();
		await editTopic();
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		fireEvent.click(await screen.findByRole("button", { name: "やめる" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(patches()).toHaveLength(0);
	});

	it("変更なしの保存は確認もPATCHも無く詳細へ戻る", async () => {
		const router = open();
		await screen.findByText("絵を見せ合う");
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(`/intents/${ID}`);
		});
		expect(patches()).toHaveLength(0);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("400の理由コードはREASON_MESSAGESの文で出す", async () => {
		patchResponse = () =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "x",
						details: { reasons: ["starts_at_out_of_range"] },
					},
				},
				400,
			);
		open();
		await editTopic();
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		fireEvent.click(
			(await screen.findByRole("dialog")).querySelector(
				".btn--primary",
			) as HTMLButtonElement,
		);
		expect(
			await screen.findByText("日時は現在以降7日以内で指定してください"),
		).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("version_conflictは案内を出して単一取得をやり直す", async () => {
		patchResponse = () =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "x",
						details: { reasons: ["version_conflict"] },
					},
				},
				400,
			);
		open();
		await editTopic();
		await waitFor(() => expect(gets()).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		fireEvent.click(
			(await screen.findByRole("dialog")).querySelector(
				".btn--primary",
			) as HTMLButtonElement,
		);
		expect(
			await screen.findByText(
				"ほかの画面で変更されました。最新の内容を読み直しました。",
			),
		).toBeTruthy();
		await waitFor(() => expect(gets().length).toBeGreaterThanOrEqual(2));
	});

	it("通信失敗(TypeError)はオフラインの案内を出す", async () => {
		patchResponse = () => {
			throw new TypeError("Failed to fetch");
		};
		open();
		await editTopic();
		fireEvent.click(screen.getByRole("button", { name: "直して預ける" }));
		fireEvent.click(
			(await screen.findByRole("dialog")).querySelector(
				".btn--primary",
			) as HTMLButtonElement,
		);
		expect(
			await screen.findByText("オフラインのため、いまは操作できません。"),
		).toBeTruthy();
	});

	it("active以外の意思で開くと詳細へreplaceで戻す", async () => {
		intent = intentOf({ status: "paused" });
		const router = open();
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(`/intents/${ID}`);
		});
		expect(router.state.historyAction).toBe("REPLACE");
		expect(screen.queryByText("内容を直す", { selector: "h1" })).toBeNull();
	});
});
