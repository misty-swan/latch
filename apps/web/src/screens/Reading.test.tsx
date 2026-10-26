/**
 * Reading画面(ボード: Reading.dc.html)の単体試験。
 * ボードどおりの読み解き中表示・parseの呼び出しと結果の受け渡し・
 * PARSE_FAILED/通信断でparse-failedへ遷移すること・直アクセス時の導線を確かめる(fetchはモック)
 */

import type { ParseIntentResponse } from "@latch/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import {
	readComposeState,
	saveComposeState,
	savePendingCompose,
} from "../intents/composeState";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";
const DRAFT_ID = "01J00000000000000000000000";

/** parse応答のフィクスチュア(docs/05 §3.3の形状) */
const parseResponse = {
	form: "connection",
	topic: "イラストを描く人とゆるくつながりたい",
	category: "創作・クリエイティブ",
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	expires_at_options: [
		"2026-10-26T12:00:00+09:00",
		"2026-11-18T12:00:00+09:00",
		"2027-01-17T12:00:00+09:00",
	],
	alcohol_involved: false,
	warnings: [],
} satisfies ParseIntentResponse;

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答 */
let parseApiResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === "/v1/intents/parse") {
			return parseApiResponse;
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.reading],
	});
	render(<RouterProvider router={router} />);
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// readingは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-reading", null);
	parseApiResponse = jsonResponse(200, parseResponse);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("Reading", () => {
	it("ボードどおりの読み解き中表示を持つ(文章・読み解いています・3つの点)", () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		setup();

		expect(screen.getByText(WORDS)).toBeTruthy();
		expect(screen.getByText("読み解いています")).toBeTruthy();
		expect(
			screen.getByText("主題と、日時・場所などの条件を読み取っています。"),
		).toBeTruthy();
		const dots = document.querySelector(".reading-dots");
		expect(dots).toBeTruthy();
		expect(dots?.querySelectorAll("i").length).toBe(3);
		expect(screen.getByRole("link", { name: "やめる" })).toBeTruthy();
	});

	it("POST /v1/intents/parseを呼び・成功するとcomposeStateへ結果を置いてconfirmへ進む", async () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.confirm);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents/parse");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ raw_text: WORDS });
		expect(readComposeState()).toEqual({
			raw_text: WORDS,
			draft_id: null,
			parse: parseResponse,
		});
	});

	it("下書きから開いた場合もdraft idをcomposeStateへ保持する", async () => {
		savePendingCompose({ raw_text: WORDS, draft_id: DRAFT_ID });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.confirm);
		});
		expect(readComposeState()?.draft_id).toBe(DRAFT_ID);
	});

	it("422 PARSE_FAILEDではparse-failedへ遷移する", async () => {
		parseApiResponse = jsonResponse(422, {
			error: {
				code: "PARSE_FAILED",
				message: "読み解けませんでした",
				details: {},
			},
		});
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.parseFailed);
		});
		expect(readComposeState()).toBeNull();
	});

	it("429 RATE_LIMITEDはparse-failedへ行かず、入力欄へ戻して案内を出す(05 §3.1)", async () => {
		parseApiResponse = jsonResponse(429, {
			error: {
				code: "RATE_LIMITED",
				message: "x",
				details: { reason: "requests_per_minute" },
			},
		});
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(
			await screen.findByText(
				"操作が続いたため、少し時間をおいてください。1分ほどでまたお使いいただけます。",
			),
		).toBeTruthy();
	});

	it("サーバーの失敗(500)でもparse-failedへ遷移する", async () => {
		parseApiResponse = jsonResponse(500, {
			error: { code: "INTERNAL", message: "x", details: {} },
		});
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.parseFailed);
		});
	});

	it("オフラインの失敗ではparse-failedへ行かず、トースト付きでcomposeへ戻る", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(
			await screen.findByText("オフラインのため、いまは読み解けません。"),
		).toBeTruthy();
	});

	it("入力が無い直アクセスではcomposeへ送り返す(parseも呼ばない)", async () => {
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("parse済みの状態では再parseせずconfirmへ進む(リロード・行き返し耐性)", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: parseResponse,
		});
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.confirm);
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
