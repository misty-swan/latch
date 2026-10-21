/**
 * Intent一覧取得(queries)の単体試験。
 * fetchIntentsがGET /v1/intents?limit=50を呼ぶこと・
 * 状態表示名の対照がdocs/01 §10どおりであることを確かめる(fetchはモック)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { intentEditPath, intentPath } from "../routes/paths";
import {
	fetchIntents,
	INTENT_STATUS_LABELS,
	intentQueryKey,
	useDeleteIntent,
	usePatchIntent,
	usePauseIntent,
	useResumeIntent,
} from "./queries";

afterEach(() => {
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("fetchIntents", () => {
	it("GET /v1/intents?limit=50を呼び・応答をそのまま返す", async () => {
		const response = {
			items: [],
			next_cursor: null,
		};
		const fetchMock = vi.fn(
			async (
				_input: RequestInfo | URL,
				_init?: RequestInit,
			): Promise<Response> =>
				new Response(JSON.stringify(response), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchIntents()).resolves.toEqual(response);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents?limit=50");
		expect(init.method ?? "GET").toBe("GET");
	});
});

describe("INTENT_STATUS_LABELS", () => {
	it("状態の表示名はdocs/01 §10の対照どおり", () => {
		// proposed以降は提案(F4以降)のデータでのみ発生するが・対照として持つ
		expect(INTENT_STATUS_LABELS).toEqual({
			draft: "下書き",
			active: "預けている",
			paused: "一時停止中",
			expired: "期限切れ",
			cancelled: "取り下げ",
			proposed: "回答を待っています",
			partial_accept: "相手の回答待ち",
			matched: "つながった",
			completed: "終了",
		});
	});
});

describe("意思のパス", () => {
	it("idをエンコードして詳細・編集のパスを作る", () => {
		expect(intentPath("a/b")).toBe("/intents/a%2Fb");
		expect(intentEditPath("I1")).toBe("/intents/I1/edit");
	});
});

describe("意思の変更hooks", () => {
	const setup = (status = 200, body: unknown = { id: "I1" }) => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				status === 204
					? new Response(null, { status })
					: new Response(JSON.stringify(body), {
							status,
							headers: { "Content-Type": "application/json" },
						}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		return { fetchMock, client, invalidate, wrapper };
	};

	it("usePauseIntentはPOST /intents/I1/pauseを呼び・個別キャッシュへ書き・一覧を無効化する", async () => {
		const { fetchMock, client, invalidate, wrapper } = setup();
		const { result } = renderHook(() => usePauseIntent("I1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync();
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents/I1/pause");
		expect(init.method).toBe("POST");
		expect(client.getQueryData(intentQueryKey("I1"))).toEqual({ id: "I1" });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["intents"] });
	});

	it("useResumeIntentはPOST /intents/I1/resumeを呼ぶ", async () => {
		const { fetchMock, wrapper } = setup();
		const { result } = renderHook(() => useResumeIntent("I1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync();
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/v1/intents/I1/resume");
	});

	it("usePatchIntentはPATCH /intents/I1へ本文を送る", async () => {
		const { fetchMock, wrapper } = setup();
		const { result } = renderHook(() => usePatchIntent("I1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync({ topic: "t" });
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents/I1");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(String(init.body))).toEqual({ topic: "t" });
	});

	it("useDeleteIntentはDELETEして個別キャッシュを捨て・一覧を無効化する", async () => {
		const { fetchMock, client, invalidate, wrapper } = setup(204);
		client.setQueryData(intentQueryKey("I1"), { id: "I1" });
		const { result } = renderHook(() => useDeleteIntent("I1"), { wrapper });
		await act(async () => {
			await result.current.mutateAsync();
		});
		expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe(
			"DELETE",
		);
		await waitFor(() =>
			expect(client.getQueryData(intentQueryKey("I1"))).toBeUndefined(),
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["intents"] });
	});
});
