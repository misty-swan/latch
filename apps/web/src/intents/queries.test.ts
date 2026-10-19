/**
 * Intent一覧取得(queries)の単体試験。
 * fetchIntentsがGET /v1/intents?limit=50を呼ぶこと・
 * 状態表示名の対照がdocs/01 §10どおりであることを確かめる(fetchはモック)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { fetchIntents, INTENT_STATUS_LABELS } from "./queries";

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
