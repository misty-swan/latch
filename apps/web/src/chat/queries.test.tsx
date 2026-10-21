import type { LatchDTO, MessageDTO, MessagePage } from "@latch/shared";
import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { latchQueryKey } from "../latches/queries";
import { createTestQueryClient } from "../test/helpers";
import {
	appendMessage,
	flattenMessages,
	messagesQueryKey,
	refreshLatestMessages,
	useConnectionsQuery,
	useHideMutation,
	useMarkRead,
	useMessagesQuery,
} from "./queries";

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	authSession.setTokens("access-1", null);
});
afterEach(() => {
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const setup = () => {
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
};

const msg = (id: string) => ({ id, body: id }) as unknown as MessageDTO;
const page = (ids: string[], next: string | null): MessagePage =>
	({ items: ids.map(msg), next_before: next }) as MessagePage;
type Cache = { pages: MessagePage[]; pageParams: unknown[] };

describe("useConnectionsQuery", () => {
	it("1頁目を取り・続きはcursorを付ける", async () => {
		fetchMock
			.mockResolvedValueOnce(
				json({ items: [{ id: "L1" } as LatchDTO], next_cursor: "C1" }),
			)
			.mockResolvedValueOnce(json({ items: [], next_cursor: null }));
		const { wrapper } = setup();
		const { result } = renderHook(() => useConnectionsQuery(), { wrapper });
		await waitFor(() => expect(result.current.data).toBeDefined());
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/v1/latches?type=matched&limit=50",
		);
		await act(async () => {
			await result.current.fetchNextPage();
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"/v1/latches?type=matched&limit=50&cursor=C1",
		);
	});
});

describe("useMessagesQuery", () => {
	it("fetchNextPageはbeforeを付ける", async () => {
		fetchMock
			.mockResolvedValueOnce(json(page(["M2", "M3"], "M2")))
			.mockResolvedValueOnce(json(page(["M1"], null)));
		const { wrapper } = setup();
		const { result } = renderHook(() => useMessagesQuery("L1"), { wrapper });
		await waitFor(() => expect(result.current.data).toBeDefined());
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/latches/L1/messages");
		await act(async () => {
			await result.current.fetchNextPage();
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"/v1/latches/L1/messages?before=M2",
		);
	});
});

describe("useMessagesQuery の再試行と再取得", () => {
	/** 本番と同じ既定(再試行あり)のQueryClient。待ちだけ0にする */
	const prodLike = () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retryDelay: 0 } },
		});
		return ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
	};
	const errorResponse = (
		status: number,
		code: string,
		details?: Record<string, unknown>,
	) =>
		json(
			{ error: { code, message: "x", ...(details ? { details } : {}) } },
			status,
		);
	afterEach(() => {
		cleanup();
		focusManager.setFocused(undefined);
	});

	it("404(NOT_FOUND)は再試行せず1回で失敗にする", async () => {
		fetchMock.mockImplementation(async () => errorResponse(404, "NOT_FOUND"));
		const { result } = renderHook(() => useMessagesQuery("L1"), {
			wrapper: prodLike(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("400 invalid_statusは再試行せず1回で失敗にする", async () => {
		fetchMock.mockImplementation(async () =>
			errorResponse(400, "VALIDATION_FAILED", { reasons: ["invalid_status"] }),
		);
		const { result } = renderHook(() => useMessagesQuery("L1"), {
			wrapper: prodLike(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("その他の失敗は既定どおり3回まで再試行する", async () => {
		fetchMock.mockImplementation(async () => errorResponse(500, "INTERNAL"));
		const { result } = renderHook(() => useMessagesQuery("L1"), {
			wrapper: prodLike(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("画面のフォーカスでは全頁を取り直さない(取りこぼしは画面側が最新頁で埋める)", async () => {
		fetchMock.mockImplementation(async () => json(page(["M1"], null)));
		const { wrapper } = setup();
		const { result } = renderHook(() => useMessagesQuery("L1"), { wrapper });
		await waitFor(() => expect(result.current.data).toBeDefined());
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await new Promise((r) => setTimeout(r, 30));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("メッセージのキャッシュ操作", () => {
	const seed = (client: ReturnType<typeof createTestQueryClient>) =>
		client.setQueryData<Cache>(messagesQueryKey("L1"), {
			pages: [page(["M3", "M4"], "M3"), page(["M1", "M2"], null)],
			pageParams: [undefined, "M3"],
		});

	it("既にあるIDは足さない", () => {
		const { client } = setup();
		seed(client);
		appendMessage(client, "L1", msg("M2"));
		const data = client.getQueryData<Cache>(messagesQueryKey("L1"));
		expect(flattenMessages(data?.pages ?? []).map((m) => m.id)).toEqual([
			"M1",
			"M2",
			"M3",
			"M4",
		]);
		expect(data?.pages[0]?.items).toHaveLength(2);
	});

	it("新しいIDはpages[0]の末尾へ足す", () => {
		const { client } = setup();
		seed(client);
		appendMessage(client, "L1", msg("M5"));
		const data = client.getQueryData<Cache>(messagesQueryKey("L1"));
		expect(data?.pages[0]?.items.map((m) => m.id)).toEqual(["M3", "M4", "M5"]);
	});

	it("キャッシュが無ければ何もしない", () => {
		const { client } = setup();
		appendMessage(client, "L1", msg("M5"));
		expect(client.getQueryData(messagesQueryKey("L1"))).toBeUndefined();
	});

	it("flattenMessagesはID昇順で重複しない", () => {
		const result = flattenMessages([
			page(["M3", "M4"], "M3"),
			page(["M2", "M3"], null),
		]);
		expect(result.map((m) => m.id)).toEqual(["M2", "M3", "M4"]);
	});

	it("refreshLatestMessagesは最新頁の新着だけを足す", async () => {
		const { client } = setup();
		seed(client);
		fetchMock.mockResolvedValueOnce(json(page(["M4", "M5", "M6"], "M4")));
		await refreshLatestMessages(client, "L1");
		const data = client.getQueryData<Cache>(messagesQueryKey("L1"));
		expect(flattenMessages(data?.pages ?? []).map((m) => m.id)).toEqual([
			"M1",
			"M2",
			"M3",
			"M4",
			"M5",
			"M6",
		]);
		expect(data?.pages).toHaveLength(2);
	});
});

describe("useMarkRead", () => {
	it("同じIDは送らず・別のIDで送る", async () => {
		fetchMock.mockImplementation(
			async () => new Response(null, { status: 204 }),
		);
		const { wrapper } = setup();
		const { result } = renderHook(() => useMarkRead("L1"), { wrapper });
		result.current("M2");
		result.current("M2");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/latches/L1/read");
		expect(init.body).toBe(JSON.stringify({ last_read_message_id: "M2" }));
		result.current("M3");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it("失敗は握りつぶす", async () => {
		fetchMock.mockRejectedValue(new Error("net"));
		const { wrapper } = setup();
		const { result } = renderHook(() => useMarkRead("L1"), { wrapper });
		expect(() => result.current("M2")).not.toThrow();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	});
});

describe("useHideMutation", () => {
	it("成功後にLATCHと履歴のキャッシュを消す", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const { client, wrapper } = setup();
		client.setQueryData(latchQueryKey("L1"), { id: "L1" });
		client.setQueryData(messagesQueryKey("L1"), { pages: [], pageParams: [] });
		const { result } = renderHook(() => useHideMutation("L1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync();
		});
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("DELETE");
		expect(client.getQueryData(latchQueryKey("L1"))).toBeUndefined();
		expect(client.getQueryData(messagesQueryKey("L1"))).toBeUndefined();
	});
});
