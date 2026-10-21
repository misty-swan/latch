/** 安全の送信(useReport・useBlock・safetyErrorText)の単体試験 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { authSession } from "../auth/session";
import { CONNECTIONS_QUERY_KEY } from "../chat/queries";
import { latchQueryKey } from "../latches/queries";
import { BLOCKS_QUERY_KEY } from "../me/queries";
import { NOTICES_QUERY_KEY } from "../notices/queries";
import { safetyErrorText, useBlock } from "./queries";

const fetchMock = vi.fn(
	async (_input: RequestInfo | URL, _init?: RequestInit) =>
		new Response(null, { status: 201 }),
);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-safety", null);
});
afterEach(() => vi.unstubAllGlobals());

describe("useBlock", () => {
	it("POST /v1/users/{id}/block を送り・4つのキーを無効化する", async () => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useBlock("L1"), { wrapper });
		result.current.mutate("u2");
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("/v1/users/u2/block");
		expect((init as RequestInit).method).toBe("POST");
		const keys = spy.mock.calls.map(([f]) => f?.queryKey);
		expect(keys).toEqual(
			expect.arrayContaining([
				latchQueryKey("L1"),
				CONNECTIONS_QUERY_KEY,
				NOTICES_QUERY_KEY,
				BLOCKS_QUERY_KEY,
			]),
		);
	});
});

describe("safetyErrorText", () => {
	it("404は区別しない一文・他は共通の失敗文", () => {
		expect(safetyErrorText(new ApiError("NOT_FOUND", "x"))).toBe(
			"この操作はできませんでした。",
		);
		expect(safetyErrorText(new Error("x"))).toBe(
			"送れませんでした。時間をおいて、もう一度お試しください。",
		);
	});
});
