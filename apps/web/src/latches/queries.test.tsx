import type { LatchDTO } from "@latch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { createTestQueryClient } from "../test/helpers";
import {
	latchQueryKey,
	useDeferReasonMutation,
	useLatchQuery,
	useRespondMutation,
} from "./queries";

const fetchMock = vi.fn();
const latch = { id: "L1", status: "proposed" } as unknown as LatchDTO;

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

const setup = () => {
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
};

const ok = () =>
	new Response(JSON.stringify(latch), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("latches mutations", () => {
	it("useRespondMutationは回答を送り・応答でキャッシュを置き換える", async () => {
		fetchMock.mockResolvedValueOnce(ok());
		const { client, wrapper } = setup();
		const { result } = renderHook(() => useRespondMutation("L1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync("yes");
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/latches/L1/response");
		expect(init.method).toBe("POST");
		expect(init.body).toBe(JSON.stringify({ response: "yes" }));
		await waitFor(() =>
			expect(client.getQueryData(latchQueryKey("L1"))).toEqual(latch),
		);
	});

	it("useDeferReasonMutationは理由を送る", async () => {
		fetchMock.mockResolvedValueOnce(ok());
		const { wrapper } = setup();
		const { result } = renderHook(() => useDeferReasonMutation("L1"), {
			wrapper,
		});
		await act(async () => {
			await result.current.mutateAsync("other");
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/latches/L1/defer-reason");
		expect(init.body).toBe(JSON.stringify({ reason: "other" }));
	});
});

describe("useLatchQuery", () => {
	/** 本番と同じ既定(再試行あり)のQueryClient。待ちだけ0にする */
	const prodLike = () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retryDelay: 0 } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		return wrapper;
	};
	const errorResponse = (status: number, code: string) =>
		new Response(JSON.stringify({ error: { code, message: "x" } }), {
			status,
			headers: { "Content-Type": "application/json" },
		});

	it("404(NOT_FOUND)は再試行せず1回で失敗にする", async () => {
		fetchMock.mockImplementation(async () => errorResponse(404, "NOT_FOUND"));
		const { result } = renderHook(() => useLatchQuery("L1"), {
			wrapper: prodLike(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("その他の失敗は既定どおり3回まで再試行する", async () => {
		fetchMock.mockImplementation(async () => errorResponse(500, "INTERNAL"));
		const { result } = renderHook(() => useLatchQuery("L1"), {
			wrapper: prodLike(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});
