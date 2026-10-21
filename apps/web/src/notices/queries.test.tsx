/** お知らせの取得(useUnreadCount・markNoticesRead)の単体試験 */

import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { createTestQueryClient } from "../test/helpers";
import { markNoticesRead, useUnreadCount } from "./queries";

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/notifications/read") {
			return new Response(null, { status: 204 });
		}
		if (url.startsWith("/v1/notifications")) {
			return new Response(
				JSON.stringify({ items: [], next_cursor: null, unread_count: 4 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`想定外のfetch: ${url} ${init?.method ?? ""}`);
	},
);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-notices", null);
});
afterEach(() => {
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("notices/queries", () => {
	it("useUnreadCountは/v1/notificationsのunread_countを返す", async () => {
		const client = createTestQueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useUnreadCount(), { wrapper });
		expect(result.current).toBe(0);
		await waitFor(() => expect(result.current).toBe(4));
	});

	it("markNoticesReadはup_to_idをPOSTする", async () => {
		await markNoticesRead("01HZZZZZZZZZZZZZZZZZZZZZZZ");
		const call = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/notifications/read",
		);
		expect(call?.[1]?.method).toBe("POST");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			up_to_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
		});
	});
});
