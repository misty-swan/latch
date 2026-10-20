import type { LatchDTO } from "@latch/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { createTestQueryClient } from "../test/helpers";
import {
	latchQueryKey,
	useDeferReasonMutation,
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
