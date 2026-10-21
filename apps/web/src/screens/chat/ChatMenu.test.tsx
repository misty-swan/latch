/**
 * 操作メニュー(ChatMenu・F6b設計 §1.6)の試験。文言・確認・要求の送信・失敗の表示は
 * ChatMenuを直接、成功後の遷移とトーストはChat経由で確かめる
 */

import type { LatchDTO } from "@latch/shared";
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
import { ChatMenu } from "./ChatMenu";

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

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let latch: LatchDTO;
let leaveResponse: () => Response;
let pendingLeave = false;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url === "/v1/users/me") return json({ id: "me" });
		if (url === "/v1/latches/L1/leave" && method === "POST") {
			if (pendingLeave) return new Promise<Response>(() => {});
			return leaveResponse();
		}
		if (url === "/v1/latches/L1" && method === "DELETE")
			return new Response(null, { status: 204 });
		if (url === "/v1/latches/L1") return json(latch);
		if (url.startsWith("/v1/latches/L1/messages"))
			return json({ items: [], next_before: null });
		if (url === "/v1/latches/L1/read")
			return new Response(null, { status: 204 });
		if (url === "/v1/ws-ticket") return json({ ticket: "tk", expires_in: 60 });
		if (url.startsWith("/v1/latches?"))
			return json({ items: [], next_cursor: null });
		throw new Error(`想定外のfetch: ${url}`);
	},
);

class FakeSocket {
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	send() {}
	close() {}
}

const callsTo = (method: string, url: string) =>
	fetchMock.mock.calls.filter(
		([u, i]) => String(u) === url && (i?.method ?? "GET") === method,
	);

const mount = (l: LatchDTO) => {
	const onLeft = vi.fn();
	const onHidden = vi.fn();
	const onClose = vi.fn();
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<ChatMenu
				latch={l}
				onClose={onClose}
				onLeft={onLeft}
				onHidden={onHidden}
			/>
		</QueryClientProvider>,
	);
	return { onLeft, onHidden, onClose };
};

const openChat = () => {
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
	vi.stubGlobal("WebSocket", FakeSocket);
	fetchMock.mockClear();
	authSession.setTokens("access-menu", null);
	latch = latchOf();
	pendingLeave = false;
	leaveResponse = () => json(latchOf({ status: "cancelled" }));
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("ChatMenu 項目と説明文", () => {
	it("matched・1対1", () => {
		mount(latchOf());
		expect(
			screen.getByRole("dialog", { name: "このつながりについて" }),
		).toBeTruthy();
		expect(screen.getByText("参加を取り消す")).toBeTruthy();
		expect(
			screen.getByText(
				"このつながりを終えます。チャットはお互いに読み取り専用になります。",
			),
		).toBeTruthy();
		expect(screen.getByText("表示から消す")).toBeTruthy();
		expect(
			screen.getByText(
				"このつながりを終えて、自分の一覧から消します。相手の側には履歴が残ります。",
			),
		).toBeTruthy();
		expect(screen.queryByText("通報する")).toBeNull();
		expect(screen.queryByText("ブロックする")).toBeNull();
	});

	it("matched・グループ", () => {
		mount(latchOf({ participants_count: 3 }));
		expect(screen.getByText("このつながりから抜けます。")).toBeTruthy();
		expect(
			screen.getByText(
				"このつながりから抜けて、自分の一覧から消します。相手の側には履歴が残ります。",
			),
		).toBeTruthy();
	});

	it("completedは「表示から消す」だけ", () => {
		mount(latchOf({ status: "completed" }));
		expect(screen.queryByText("参加を取り消す")).toBeNull();
		expect(screen.getByText("表示から消す")).toBeTruthy();
		expect(
			screen.getByText("自分の一覧から消します。相手の側には残ります。"),
		).toBeTruthy();
	});

	it("[閉じる]でonCloseが呼ばれる", () => {
		const { onClose } = mount(latchOf());
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("ChatMenu 確認と操作", () => {
	it("参加を取り消す→確認→[やめる]では要求を送らず・[取り消す]でPOSTを1回送る", async () => {
		const { onLeft } = mount(latchOf());
		fireEvent.click(screen.getByText("参加を取り消す"));
		expect(
			screen.getByText("参加を取り消しますか。元には戻せません。"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "やめる" }));
		expect(callsTo("POST", "/v1/latches/L1/leave")).toHaveLength(0);
		fireEvent.click(screen.getByText("参加を取り消す"));
		fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
		await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
		expect(callsTo("POST", "/v1/latches/L1/leave")).toHaveLength(1);
		expect(onLeft.mock.calls[0]?.[0].status).toBe("cancelled");
	});

	it("表示から消す→[消す]でDELETEを送る", async () => {
		const { onHidden } = mount(latchOf());
		fireEvent.click(screen.getByText("表示から消す"));
		expect(
			screen.getByText("表示から消しますか。元には戻せません。"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "消す" }));
		await waitFor(() => expect(onHidden).toHaveBeenCalledTimes(1));
		expect(callsTo("DELETE", "/v1/latches/L1")).toHaveLength(1);
	});

	it("送信中は確認のボタンを押せない", async () => {
		pendingLeave = true;
		mount(latchOf());
		fireEvent.click(screen.getByText("参加を取り消す"));
		const ok = screen.getByRole("button", { name: "取り消す" });
		fireEvent.click(ok);
		await waitFor(() => expect((ok as HTMLButtonElement).disabled).toBe(true));
		expect(
			(screen.getByRole("button", { name: "やめる" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("leaveが400なら「この操作は、いまはできません。」を出しLATCHを取り直す", async () => {
		leaveResponse = () =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "x",
						details: { reasons: ["invalid_status"] },
					},
				},
				400,
			);
		const { onLeft } = mount(latchOf());
		fireEvent.click(screen.getByText("参加を取り消す"));
		fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
		expect(
			await screen.findByText("この操作は、いまはできません。"),
		).toBeTruthy();
		expect(onLeft).not.toHaveBeenCalled();
	});
});

describe("Chat 経由の遷移とトースト", () => {
	const startLeave = async () => {
		const router = openChat();
		fireEvent.click(await screen.findByLabelText("このつながりについて"));
		fireEvent.click(await screen.findByText("参加を取り消す"));
		fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
		return router;
	};

	it("1対1: cancelledの応答でその場に留まり読み取り専用になりトーストが出る", async () => {
		leaveResponse = () => {
			latch = latchOf({ status: "cancelled" });
			return json(latch);
		};
		const router = await startLeave();
		expect(await screen.findByText("参加を取り消しました。")).toBeTruthy();
		expect(await screen.findByText("このつながりは終了しました")).toBeTruthy();
		expect(router.state.location.pathname).toBe("/latches/L1/chat");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("グループ: 本人だけ抜けた(matched)応答は/connectionsへreplaceで移る", async () => {
		latch = latchOf({ participants_count: 3 });
		leaveResponse = () => json(latchOf({ participants_count: 3 }));
		const router = await startLeave();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/connections"),
		);
		expect(router.state.location.state).toEqual({
			toast: "参加を取り消しました。",
		});
		expect(await screen.findByText("参加を取り消しました。")).toBeTruthy();
	});

	it("表示から消す→/connectionsに「一覧から消しました。」", async () => {
		const router = openChat();
		fireEvent.click(await screen.findByLabelText("このつながりについて"));
		fireEvent.click(await screen.findByText("表示から消す"));
		fireEvent.click(screen.getByRole("button", { name: "消す" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/connections"),
		);
		expect(await screen.findByText("一覧から消しました。")).toBeTruthy();
	});
});
