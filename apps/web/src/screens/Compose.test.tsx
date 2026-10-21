/**
 * Compose画面(ボード: Compose.dc.html・ComposeFull.dc.html)の単体試験。
 * 300字カウンタ・空欄/301字で読み解けないこと・parseへの受け渡し・
 * 下書きの新規保存と?draft=<id>からの復元+PATCH更新を確かめる(fetchはモック)
 */

import {
	type IntentDTO,
	LIMITS,
	type ParseIntentResponse,
} from "@latch/shared";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { readComposeState } from "../intents/composeState";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";

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

/** 下書きIntentのフィクスチュア(docs/05 §3.3のIntentDTO) */
const draftIntent: IntentDTO = {
	id: "01J00000000000000000000000",
	form: null,
	topic: null,
	category: null,
	raw_text: "英語を母語とする人と、ゆるくランゲージエクスチェンジ",
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	hard_constraints: [],
	soft_constraints: [],
	negative_constraints: [],
	visibility: "hidden_until_match",
	notification_level: "proposals_only",
	alcohol_involved: false,
	status: "draft",
	version: 1,
	expires_at: null,
	created_at: "2026-10-17T09:00:00+09:00",
	updated_at: "2026-10-17T09:00:00+09:00",
};

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答 */
let parseApiResponse: Response;
let createResponse: Response;
let getResponse: Response;
let patchResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url === "/v1/intents/parse" && method === "POST") {
			return parseApiResponse;
		}
		if (url === "/v1/intents" && method === "POST") {
			return createResponse;
		}
		if (url === `/v1/intents/${draftIntent.id}` && method === "GET") {
			return getResponse;
		}
		if (url === `/v1/intents/${draftIntent.id}` && method === "PATCH") {
			return patchResponse;
		}
		// 下書き保存などの後に着地するhome一覧(Task 6)は空で返す
		if (url === "/v1/intents?limit=50" && method === "GET") {
			return jsonResponse(200, { items: [], next_cursor: null });
		}
		// homeの提案取得(F4c)も空で返す
		if (url === "/v1/latches?type=proposals&limit=50" && method === "GET") {
			return jsonResponse(200, { items: [], next_cursor: null });
		}
		// 右上のお知らせ(未読件数)と自分の取得(TopbarActions)も空で返す
		if (url.startsWith("/v1/notifications") && method === "GET") {
			return jsonResponse(200, {
				items: [],
				next_cursor: null,
				unread_count: 0,
			});
		}
		if (url === "/v1/users/me" && method === "GET") {
			return jsonResponse(200, { id: "u1", has_icon: false });
		}
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);

const setup = (path: string = PATHS.compose) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [path],
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

const textbox = (): HTMLTextAreaElement =>
	screen.getByLabelText(
		`繋がりたいこと(${LIMITS.RAW_TEXT_MAX_LENGTH}字まで)`,
	) as HTMLTextAreaElement;
const counter = (): HTMLElement =>
	document.querySelector('[aria-live="polite"]') as HTMLElement;

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// composeは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-compose", null);
	parseApiResponse = jsonResponse(
		200,
		parseResponse satisfies ParseIntentResponse,
	);
	createResponse = jsonResponse(201, { ...draftIntent, raw_text: WORDS });
	getResponse = jsonResponse(200, draftIntent);
	patchResponse = jsonResponse(200, {
		...draftIntent,
		raw_text: "書き直した文章",
		version: 2,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("Compose", () => {
	it("遷移元が渡したstate.toastをトーストに出す", async () => {
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [
				{
					pathname: PATHS.compose,
					state: { toast: "オフラインのため、いまは読み解けません。" },
				},
			],
		});
		render(withQueryClient(<RouterProvider router={router} />));
		expect(
			await screen.findByText("オフラインのため、いまは読み解けません。"),
		).toBeTruthy();
	});

	it("ボードどおりのコピー・便箋・プライバシー表示と・カウンタは0/300から始まる", () => {
		setup();

		expect(screen.getByText("置く")).toBeTruthy();
		expect(
			screen.getByText("どんな人と、どんなふうに繋がりたいですか。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"日時や場所が決まっているなら、そのまま書いてください。",
			),
		).toBeTruthy();
		expect(screen.getByText("ほかの人には表示されません。")).toBeTruthy();

		const text = textbox();
		expect(text.maxLength).toBe(LIMITS.RAW_TEXT_MAX_LENGTH);
		expect(text.getAttribute("placeholder")).toBe(
			"例: イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。",
		);
		expect(counter().textContent).toBe(`0 / ${LIMITS.RAW_TEXT_MAX_LENGTH}`);

		expect(screen.getByRole("link", { name: "閉じる" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "下書きに残す" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "読み解く" })).toBeTruthy();
	});

	it("入力に合わせカウンタが動き・残りわずかでis-near・300字でis-fullになる", () => {
		setup();

		fireEvent.change(textbox(), {
			target: { value: "あ".repeat(42) },
		});
		expect(counter().textContent).toBe(`42 / ${LIMITS.RAW_TEXT_MAX_LENGTH}`);
		expect(counter().className).toBe("counter");

		fireEvent.change(textbox(), {
			target: { value: "あ".repeat(LIMITS.RAW_TEXT_MAX_LENGTH - 15) },
		});
		expect(counter().className).toBe("counter is-near");

		fireEvent.change(textbox(), {
			target: { value: "あ".repeat(LIMITS.RAW_TEXT_MAX_LENGTH) },
		});
		expect(counter().className).toBe("counter is-full");
		// 便箋がいっぱいの状態のヒント(ボードComposeFull.dc.htmlどおり)
		expect(
			screen.getByText(`${LIMITS.RAW_TEXT_MAX_LENGTH}字まで書けます。`),
		).toBeTruthy();
	});

	it("空欄では読み解けない(ボタンが無効・APIも呼ばない)", async () => {
		const router = setup();

		const button = screen.getByRole("button", {
			name: "読み解く",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		fireEvent.change(textbox(), { target: { value: "　" } });
		expect(
			(screen.getByRole("button", { name: "読み解く" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "読み解く" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("301字の入力は読み解けない(maxlength属性を迂回しても検証で止める)", async () => {
		const router = setup();

		fireEvent.change(textbox(), {
			target: { value: "あ".repeat(LIMITS.RAW_TEXT_MAX_LENGTH + 1) },
		});
		const button = screen.getByRole("button", {
			name: "読み解く",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		fireEvent.click(button);

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("読み解くで/readingへ遷移してparseを呼び・成功するとconfirmへ進む(stateに結果)", async () => {
		const router = setup();

		fireEvent.change(textbox(), { target: { value: WORDS } });
		fireEvent.click(screen.getByRole("button", { name: "読み解く" }));

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

	it('下書きに残すでraw_textのみPOST /v1/intents {status:"draft"}してhomeへ進む', async () => {
		const router = setup();

		fireEvent.change(textbox(), { target: { value: WORDS } });
		fireEvent.click(screen.getByRole("button", { name: "下書きに残す" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			status: "draft",
			raw_text: WORDS,
		});
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
	});

	it("空欄で下書きに残すを押すと保存せずhomeへ戻る", async () => {
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "下書きに残す" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
		// homeの一覧取得(limit=50)と提案取得・右上の取得のみが走り・空欄の下書き保存はしない
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(4);
		});
		const listCall = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/intents?limit=50",
		) as [string, RequestInit | undefined];
		expect(listCall).toBeDefined();
		expect(listCall[1]?.method ?? "GET").toBe("GET");
	});

	it("?draft=<id>付きで開くと下書きの文章を復元し・下書きに残すはPATCHで更新する", async () => {
		const router = setup(`${PATHS.compose}?draft=${draftIntent.id}`);

		const restored = (await screen.findByDisplayValue(
			draftIntent.raw_text,
		)) as HTMLTextAreaElement;
		expect(restored.value).toBe(draftIntent.raw_text);
		expect(counter().textContent).toBe(
			`${draftIntent.raw_text.length} / ${LIMITS.RAW_TEXT_MAX_LENGTH}`,
		);

		fireEvent.change(restored, { target: { value: "書き直した文章" } });
		fireEvent.click(screen.getByRole("button", { name: "下書きに残す" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(url).toBe(`/v1/intents/${draftIntent.id}`);
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string)).toEqual({
			raw_text: "書き直した文章",
		});
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
	});

	it("?draft=<id>の取得に失敗したら新規の預ける画面として扱う", async () => {
		getResponse = jsonResponse(404, {
			error: { code: "NOT_FOUND", message: "見つかりません", details: {} },
		});
		setup(`${PATHS.compose}?draft=${draftIntent.id}`);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		expect(
			(await screen.findByLabelText(
				`繋がりたいこと(${LIMITS.RAW_TEXT_MAX_LENGTH}字まで)`,
			)) as HTMLTextAreaElement,
		).toBeTruthy();
		expect(textbox().value).toBe("");
		expect(counter().textContent).toBe(`0 / ${LIMITS.RAW_TEXT_MAX_LENGTH}`);
	});

	it("下書きの保存に失敗したらエラーを表示して画面に留まる", async () => {
		createResponse = jsonResponse(500, {
			error: { code: "INTERNAL", message: "内部エラー", details: {} },
		});
		const router = setup();

		fireEvent.change(textbox(), { target: { value: WORDS } });
		fireEvent.click(screen.getByRole("button", { name: "下書きに残す" }));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.compose);
	});
});
