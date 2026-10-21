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
import { CONNECTIONS_QUERY_KEY, messagesQueryKey } from "../../chat/queries";
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
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
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
		if (url === "/v1/latches/L1/read")
			return new Response(null, { status: 204 });
		if (url === "/v1/ws-ticket") return json({ ticket: "tk", expires_in: 60 });
		throw new Error(`想定外のfetch: ${url}`);
	},
);

class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeSocket.all.push(this);
	}
	send() {}
	close() {
		this.closed = true;
	}
	recv(m: MessageDTO) {
		this.onmessage?.({ data: JSON.stringify({ type: "message", ...m }) });
	}
}

const open = (client = createTestQueryClient()) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: ["/latches/L1/chat"],
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	FakeSocket.all = [];
	vi.stubGlobal("WebSocket", FakeSocket);
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
		expect(await screen.findByText("本文02")).toBeTruthy();
		expect(screen.getByText("10月10日 17:40 につながりました")).toBeTruthy();
		// 届いたメッセージを読み上げる領域(polite)
		expect(screen.getByRole("log").textContent).toContain("本文02");
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
		// 古い頁が残っている間は冒頭(つながりました)を出さない
		expect(screen.queryByText(/につながりました/)).toBeNull();
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
		expect(screen.getByText("10月10日 17:40 につながりました")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "古いメッセージを読み込む" }),
		).toBeNull();
	});
});

describe("Chat の送信・受信・既読", () => {
	const field = () => screen.getByLabelText("メッセージ");
	const postCalls = () =>
		fetchMock.mock.calls.filter(
			([u, init]) =>
				String(u) === "/v1/latches/L1/messages" &&
				(init as RequestInit | undefined)?.method === "POST",
		);
	const bodyOf = (call: unknown[]) =>
		JSON.parse(String((call[1] as RequestInit).body));
	const baseImpl = fetchMock.getMockImplementation() as (
		i: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	const withPost = (
		handler: (init: RequestInit) => Promise<Response> | Response,
	) =>
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (
					String(input) === "/v1/latches/L1/messages" &&
					init?.method === "POST"
				) {
					return handler(init);
				}
				return baseImpl(input, init);
			},
		);
	const type = async (text: string) => {
		await screen.findByText("本文02");
		fireEvent.change(field(), { target: { value: text } });
		fireEvent.click(screen.getByRole("button", { name: "送る" }));
	};
	afterEach(() => fetchMock.mockImplementation(baseImpl));

	it("送信で{body, client_id}をPOSTし・応答前はis-sendingの吹き出しが出る", async () => {
		let release: (r: Response) => void = () => {};
		withPost(() => new Promise<Response>((r) => (release = r)));
		open();
		await type("  こんにちは ");
		await waitFor(() => expect(postCalls()).toHaveLength(1));
		const sent = bodyOf(postCalls()[0] as unknown[]);
		expect(sent.body).toBe("こんにちは");
		expect(typeof sent.client_id).toBe("string");
		const bubble = screen.getByText("こんにちは").closest(".msg");
		expect(bubble?.classList.contains("is-sending")).toBe(true);
		release(
			json(
				{ ...msg("03", "me"), body: "こんにちは", client_id: sent.client_id },
				201,
			),
		);
		await waitFor(() =>
			expect(document.querySelector(".msg.is-sending")).toBeNull(),
		);
		expect(screen.getAllByText("こんにちは")).toHaveLength(1);
	});

	it("WebSocketで同じclient_idが先に届いても吹き出しは1つ", async () => {
		let release: (r: Response) => void = () => {};
		withPost(() => new Promise<Response>((r) => (release = r)));
		open();
		await type("やあ");
		await waitFor(() => expect(postCalls()).toHaveLength(1));
		const cid = bodyOf(postCalls()[0] as unknown[]).client_id;
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		const confirmed = { ...msg("03", "me"), body: "やあ", client_id: cid };
		FakeSocket.all[0]?.recv(confirmed);
		await waitFor(() =>
			expect(document.querySelector(".msg.is-sending")).toBeNull(),
		);
		expect(screen.getAllByText("やあ")).toHaveLength(1);
		release(json(confirmed, 201));
		await waitFor(() => expect(screen.getAllByText("やあ")).toHaveLength(1));
	});

	it("500で失敗表示と[もう一度送る]が出て・再送は同じclient_id", async () => {
		let n = 0;
		withPost((init) => {
			n += 1;
			if (n === 1) {
				return json({ error: { code: "INTERNAL", message: "x" } }, 500);
			}
			return json(
				{
					...msg("03", "me"),
					body: "失敗する",
					client_id: JSON.parse(String(init.body)).client_id,
				},
				201,
			);
		});
		open();
		await type("失敗する");
		fireEvent.click(
			await screen.findByRole("button", { name: "もう一度送る" }),
		);
		expect(screen.queryByText("送信できませんでした")).toBeNull();
		await waitFor(() => expect(postCalls()).toHaveLength(2));
		expect(bodyOf(postCalls()[1] as unknown[]).client_id).toBe(
			bodyOf(postCalls()[0] as unknown[]).client_id,
		);
		await waitFor(() =>
			expect(
				document.querySelector(".msg.is-failed, .msg.is-sending"),
			).toBeNull(),
		);
	});

	it("失敗時は「送信できませんでした」が出る", async () => {
		withPost(() => json({ error: { code: "INTERNAL", message: "x" } }, 500));
		open();
		await type("だめ");
		expect(await screen.findByText(/送信できませんでした/)).toBeTruthy();
		expect(document.querySelector(".msg.is-failed")).not.toBeNull();
	});

	it("通信失敗(TypeError)ではオフラインのトーストと[もう一度送る]を出す", async () => {
		withPost(() => {
			throw new TypeError("Failed to fetch");
		});
		open();
		await type("届かない");
		expect(
			await screen.findByText("オフラインのため、送れませんでした。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "もう一度送る" })).toBeTruthy();
	});

	it("400 read_onlyは失敗表示を出さずLATCHを取り直す", async () => {
		withPost(() =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "x",
						details: { reasons: ["read_only"] },
					},
				},
				400,
			),
		);
		open();
		await screen.findByText("本文02");
		const before = fetchMock.mock.calls.filter(
			([u]) => String(u) === "/v1/latches/L1",
		).length;
		fireEvent.change(field(), { target: { value: "終わった" } });
		fireEvent.click(screen.getByRole("button", { name: "送る" }));
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.filter(([u]) => String(u) === "/v1/latches/L1")
					.length,
			).toBeGreaterThan(before),
		);
		expect(screen.queryByText(/送信できませんでした/)).toBeNull();
		expect(screen.queryByText("終わった")).toBeNull();
	});

	it("WebSocketのmessageで相手の吹き出しが増え・既読がその最新IDで送られる", async () => {
		open();
		await screen.findByText("本文02");
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		FakeSocket.all[0]?.recv(msg("09", "u2"));
		expect(await screen.findByText("本文09")).toBeTruthy();
		await waitFor(() => {
			const reads = fetchMock.mock.calls.filter(
				([u]) => String(u) === "/v1/latches/L1/read",
			);
			expect(
				reads.map((c) => JSON.parse(String((c[1] as RequestInit).body))),
			).toContainEqual({ last_read_message_id: "09" });
		});
	});

	it("completedではWebSocketを作らない", async () => {
		latch = latchOf({ status: "completed" });
		open();
		await screen.findByText("本文02");
		expect(FakeSocket.all).toHaveLength(0);
	});

	it("windowのfocusで最新頁(before無し)を取り直す", async () => {
		open();
		await screen.findByText("本文02");
		fetchMock.mockClear();
		fireEvent.focus(window);
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([u]) => String(u) === "/v1/latches/L1/messages",
				),
			).toBe(true),
		);
	});
	const stubScroll = () => {
		const el = document.querySelector(".screen__body") as HTMLElement;
		Object.defineProperty(el, "scrollHeight", {
			configurable: true,
			value: 1000,
		});
		Object.defineProperty(el, "clientHeight", {
			configurable: true,
			value: 500,
		});
		return el;
	};

	it("最下部から離れて読んでいるときは相手のmessageでスクロール位置を変えない", async () => {
		open();
		await screen.findByText("本文02");
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		const el = stubScroll();
		el.scrollTop = 100;
		fireEvent.scroll(el);
		FakeSocket.all[0]?.recv(msg("09", "u2"));
		await screen.findByText("本文09");
		expect(el.scrollTop).toBe(100);
	});

	it("最下部付近を見ているときは相手のmessageで最下部へ追う", async () => {
		open();
		await screen.findByText("本文02");
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		const el = stubScroll();
		el.scrollTop = 450;
		fireEvent.scroll(el);
		FakeSocket.all[0]?.recv(msg("09", "u2"));
		await screen.findByText("本文09");
		expect(el.scrollTop).toBe(1000);
	});

	it("自分の送信は最下部から離れていても最下部へスクロールする", async () => {
		withPost(() => new Promise<Response>(() => {}));
		open();
		await screen.findByText("本文02");
		const el = stubScroll();
		el.scrollTop = 100;
		fireEvent.scroll(el);
		fireEvent.change(field(), { target: { value: "送るよ" } });
		fireEvent.click(screen.getByRole("button", { name: "送る" }));
		await screen.findByText("送るよ");
		expect(el.scrollTop).toBe(1000);
	});

	it("履歴の取り直し中に送信が成功しても・古い一覧で上書きされず吹き出しが残る", async () => {
		const client = createTestQueryClient();
		let hold: ((r: Response) => void) | null = null;
		let armed = false;
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "/v1/latches/L1/messages" && init?.method === "POST") {
					const cid = JSON.parse(String(init.body)).client_id;
					return json(
						{ ...msg("03", "me"), body: "途中で送る", client_id: cid },
						201,
					);
				}
				if (url === "/v1/latches/L1/messages" && hold === null && armed) {
					// 取り直しの応答を止めておき・後から古い一覧で返す
					return new Promise<Response>((r) => (hold = r));
				}
				return baseImpl(input, init);
			},
		);
		open(client);
		await screen.findByText("本文02");
		armed = true;
		void client.refetchQueries({ queryKey: messagesQueryKey("L1") });
		await waitFor(() => expect(hold).not.toBeNull());
		fireEvent.change(field(), { target: { value: "途中で送る" } });
		fireEvent.click(screen.getByRole("button", { name: "送る" }));
		await waitFor(() =>
			expect(document.querySelector(".msg.is-sending")).toBeNull(),
		);
		expect(screen.getByText("途中で送る")).toBeTruthy();
		(hold as ((r: Response) => void) | null)?.(
			json({ items: [msg("02", "me")], next_before: null }),
		);
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(screen.getByText("途中で送る")).toBeTruthy();
		expect(screen.getByText("本文02")).toBeTruthy();
	});

	it("送信の成功後につながり一覧とLATCHを無効化する", async () => {
		const client = createTestQueryClient();
		withPost((init) =>
			json(
				{
					...msg("03", "me"),
					body: "一覧も",
					client_id: JSON.parse(String(init.body)).client_id,
				},
				201,
			),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const invalidated = (key: readonly unknown[]) =>
			invalidate.mock.calls.some(
				([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(key),
			);
		open(client);
		await screen.findByText("本文02");
		const latchGets = () =>
			fetchMock.mock.calls.filter(
				([u, i]) =>
					String(u) === "/v1/latches/L1" &&
					((i as RequestInit | undefined)?.method ?? "GET") === "GET",
			).length;
		const before = latchGets();
		expect(invalidated(CONNECTIONS_QUERY_KEY)).toBe(false);
		fireEvent.change(field(), { target: { value: "一覧も" } });
		fireEvent.click(screen.getByRole("button", { name: "送る" }));
		await waitFor(() => expect(invalidated(CONNECTIONS_QUERY_KEY)).toBe(true));
		await waitFor(() => expect(latchGets()).toBeGreaterThan(before));
	});
});

describe("Chat の既読と画面の表示状態", () => {
	let visibility: DocumentVisibilityState = "visible";
	beforeEach(() => {
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => visibility,
		});
	});
	afterEach(() => {
		// 上書きを外して既定の値へ戻す
		delete (document as unknown as Record<string, unknown>).visibilityState;
	});
	const reads = () =>
		fetchMock.mock.calls
			.filter(([u]) => String(u) === "/v1/latches/L1/read")
			.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
	const show = () => {
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
	};

	it("画面が隠れている間は既読を送らず・表示に戻ったら送る", async () => {
		visibility = "hidden";
		open();
		await screen.findByText("本文02");
		await new Promise((r) => setTimeout(r, 30));
		expect(reads()).toHaveLength(0);
		show();
		await waitFor(() =>
			expect(reads()).toContainEqual({ last_read_message_id: "02" }),
		);
	});

	it("隠れている間に届いたmessageは・表示に戻ったときその最新IDで既読を送る", async () => {
		open();
		await screen.findByText("本文02");
		await waitFor(() =>
			expect(reads()).toContainEqual({ last_read_message_id: "02" }),
		);
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		FakeSocket.all[0]?.recv(msg("09", "u2"));
		await screen.findByText("本文09");
		await new Promise((r) => setTimeout(r, 30));
		expect(reads()).not.toContainEqual({ last_read_message_id: "09" });
		show();
		await waitFor(() =>
			expect(reads()).toContainEqual({ last_read_message_id: "09" }),
		);
	});
});

describe("Chat のメッセージの操作", () => {
	it("相手の発言の操作→「このメッセージについて」→「このメッセージを通報する」で発言と相手付きの通報画面へ(引用をstateで渡す)", async () => {
		history = {
			"": { items: [msg("M1", "u2"), msg("02", "me")], next_before: null },
		};
		const router = open();
		fireEvent.click(
			await screen.findByRole("button", { name: "このメッセージの操作" }),
		);
		expect(
			screen.getByRole("dialog", { name: "このメッセージについて" }),
		).toBeTruthy();
		fireEvent.click(screen.getByText("このメッセージを通報する"));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1/report"),
		);
		expect(router.state.location.search).toBe("?message=M1&user=u2");
		expect(router.state.location.state).toEqual({ quote: "本文M1" });
	});

	it("[閉じる]でシートが閉じる", async () => {
		history = { "": { items: [msg("M1", "u2")], next_before: null } };
		open();
		fireEvent.click(
			await screen.findByRole("button", { name: "このメッセージの操作" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(
			screen.queryByRole("dialog", { name: "このメッセージについて" }),
		).toBeNull();
	});
});
