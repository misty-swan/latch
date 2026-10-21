/**
 * Home画面(ボード: Home.dc.html・HomeEmpty.dc.html)の単体試験。
 * 一覧カード(words・formラベル・状態表示名01 §10対照)・下書きカードの再開リンク・
 * 空状態のコピー・取得失敗時の再試行導線を確かめる(fetchはモック)
 * 提案の到着カード(arrival)・意思カードの「回答を待っています」・器の灯りも確かめる(F4c)
 */

import type { IntentDTO, LatchDTO } from "@latch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { browserPushEnv } from "../push/subscription";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";
import { restoreOnline, setOnline } from "../test/offline";

const DAY_MS = 24 * 3_600_000;

/** nowからのオフセット(ミリ秒)でISO時刻を作る(試験を現在時刻に依存させない) */
const iso = (offsetMs: number): string =>
	new Date(Date.now() + offsetMs).toISOString();

/** IntentDTOの共通欄(docs/05 §2.2の形状) */
const base = {
	visibility: "hidden_until_match",
	notification_level: "proposals_only",
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	geo: null,
	topic: null,
	category: null,
	alcohol_involved: false,
	version: 1,
} as const;

const constraints = {
	hard_constraints: [],
	soft_constraints: [],
	negative_constraints: [],
};

/** 預けている(つながり・active)。board Home.dc.htmlの1枚目のカードに揃えた数値 */
const connectionIntent: IntentDTO = {
	...base,
	...constraints,
	id: "01J00000000000000000000001",
	form: "connection",
	raw_text:
		"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。",
	time: null,
	status: "active",
	expires_at: iso(18 * DAY_MS),
	created_at: iso(-12 * DAY_MS),
	updated_at: iso(-12 * DAY_MS),
};

/** 預けている(機会・active)。開始まで1時間40分の機会 */
const occasionIntent: IntentDTO = {
	...base,
	...constraints,
	id: "01J00000000000000000000002",
	form: "occasion",
	raw_text:
		"今夜20時以降、天文館あたりで2〜4人、5,000円以内で軽く飲みに行きたい。",
	time: { start: iso(100 * 60_000), end: null },
	status: "active",
	expires_at: iso(2 * DAY_MS),
	created_at: iso(-2 * 3_600_000),
	updated_at: iso(-2 * 3_600_000),
};

/** 一時停止中(つながり) */
const pausedIntent: IntentDTO = {
	...base,
	...constraints,
	id: "01J00000000000000000000004",
	form: "connection",
	raw_text: "子育て中の親と、子どもが寝たあとに少しだけ話せる関係が欲しい。",
	time: null,
	status: "paused",
	expires_at: iso(59 * DAY_MS),
	created_at: iso(-31 * DAY_MS),
	updated_at: iso(-1 * DAY_MS),
};

/** 下書き(board IntentDraft.dc.htmlの文章) */
const draftIntent: IntentDTO = {
	...base,
	...constraints,
	id: "01J00000000000000000000003",
	form: null,
	raw_text: "英語を母語とする人と、ゆるくランゲージエクスチェンジ",
	time: null,
	status: "draft",
	expires_at: null,
	created_at: iso(-2 * DAY_MS),
	updated_at: iso(-2 * DAY_MS),
};

/** 期限切れ(board Home.dc.htmlの下書き・期限切れ欄) */
const expiredIntent: IntentDTO = {
	...base,
	...constraints,
	id: "01J00000000000000000000005",
	form: "connection",
	raw_text: "鹿児島でサイクリングする人と繋がりたい。週末に桜島をまわれたら。",
	time: null,
	status: "expired",
	expires_at: iso(-6 * DAY_MS),
	created_at: iso(-36 * DAY_MS),
	updated_at: iso(-6 * DAY_MS),
};

/** 進行中の提案(LatchDTO)。回答期限はnowから1日後 */
const proposalOf = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "L1",
		form: "connection",
		status: "proposed",
		response_deadline: iso(DAY_MS),
		participants_count: 2,
		my_response: null,
		score: 0.5,
		my_intent_id: connectionIntent.id,
		matched_at: null,
		...over,
	}) as LatchDTO;

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答(GET /v1/intents?limit=50) */
let listResponse: Response;
/** テストが差し替える応答(GET /v1/latches?type=proposals&limit=50) */
let proposalsResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === "/v1/intents?limit=50") {
			return listResponse;
		}
		if (url === "/v1/latches?type=proposals&limit=50") {
			return proposalsResponse;
		}
		if (url.startsWith("/v1/notifications")) {
			return new Response(
				JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === "/v1/users/me") {
			return new Response(JSON.stringify({ id: "u1", has_icon: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

/** 意思一覧(GET /v1/intents)の呼び出し回数(提案の取得は数えない) */
const intentListCalls = (): number =>
	fetchMock.mock.calls.filter(([url]) => String(url) === "/v1/intents?limit=50")
		.length;

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.home],
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// homeは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-home", null);
	listResponse = jsonResponse(200, { items: [], next_cursor: null });
	proposalsResponse = jsonResponse(200, { items: [], next_cursor: null });
	// 既定は通知の許可が未決(帯は出ない)
	vi.spyOn(browserPushEnv, "permission").mockReturnValue("default");
});

afterEach(() => {
	restoreOnline();
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("Home", () => {
	it("一覧を描画する(words・formラベル・状態表示名・件数caption・経過表示)", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent, occasionIntent],
			next_cursor: null,
		});
		setup();

		expect(
			await screen.findByText("いま、2つの意思を預けています。"),
		).toBeTruthy();
		expect(screen.getByText(connectionIntent.raw_text)).toBeTruthy();
		expect(screen.getByText(occasionIntent.raw_text)).toBeTruthy();
		expect(screen.getByRole("heading", { name: "預けている" })).toBeTruthy();
		// つながりはカードのformラベル+下部タブぶん・機会はカードのformラベルのみ
		expect(screen.getAllByText("つながり").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText("機会")).toBeTruthy();
		// 状態表示名「預けている」はカード2枚ぶん(見出し・タブと重複するため件数で見る)
		expect(screen.getAllByText("預けている").length).toBeGreaterThanOrEqual(4);
		// つながりカードの経過(預けて12日・あと18日)と機会の開始前表示
		expect(screen.getByText("預けて12日")).toBeTruthy();
		expect(screen.getByText("あと18日")).toBeTruthy();
		expect(screen.getByText(/^開始まで/)).toBeTruthy();
		// 提案が無ければ到着カードは出ない
		expect(document.querySelector(".arrival")).toBeNull();
	});

	it("未回答の提案は到着カードとして出て、提案の画面へつながる", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, {
			items: [proposalOf()],
			next_cursor: null,
		});
		setup();

		expect(await screen.findByText("提案が届いています")).toBeTruthy();
		const card = document.querySelector(".arrival") as HTMLAnchorElement;
		expect(card.getAttribute("href")).toBe("/latches/L1");
		expect(card.className).not.toContain("is-pressed");
		expect(card.textContent).toContain("回答期限");
	});

	it("yes済みは「相手の回答を待っています」でis-pressed", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, {
			items: [proposalOf({ my_response: "yes" })],
			next_cursor: null,
		});
		setup();

		expect(await screen.findByText("相手の回答を待っています")).toBeTruthy();
		expect(document.querySelector(".arrival.is-pressed")).not.toBeNull();
	});

	it("グループの到着カードは人数を出す", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, {
			items: [proposalOf({ participants_count: 3 })],
			next_cursor: null,
		});
		setup();

		await screen.findByText("提案が届いています");
		expect(document.querySelector(".arrival")?.textContent).toContain("·3人");
	});

	it("提案が届いている意思のカードは「回答を待っています」になる", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent, occasionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, {
			items: [proposalOf({ my_intent_id: connectionIntent.id })],
			next_cursor: null,
		});
		setup();

		await screen.findByText("提案が届いています");
		const lamps = document.querySelectorAll(".status--lamp");
		expect(lamps.length).toBe(1);
		expect(lamps[0]?.textContent).toBe("回答を待っています");
		expect(lamps[0]?.closest(".intent")?.textContent).toContain(
			connectionIntent.raw_text,
		);
	});

	it("my_intent_idがnullの提案はどの意思カードにも当たらない", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, {
			items: [proposalOf({ my_intent_id: null })],
			next_cursor: null,
		});
		setup();

		await screen.findByText("提案が届いています");
		expect(document.querySelectorAll(".status--lamp").length).toBe(0);
	});

	const litVessel = async (items: LatchDTO[], waitText?: string) => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(200, { items, next_cursor: null });
		setup();
		await screen.findByText(connectionIntent.raw_text);
		if (waitText !== undefined) {
			await screen.findByText(waitText);
		}
		return document.querySelector(".vessel")?.className ?? "";
	};

	it("器の灯りは提案がなければ点かない", async () => {
		expect(await litVessel([])).not.toContain("is-lit");
	});

	it("器の灯りはyes済みの提案だけでは点かない", async () => {
		expect(
			await litVessel(
				[proposalOf({ my_response: "yes" })],
				"相手の回答を待っています",
			),
		).not.toContain("is-lit");
	});

	it("器の灯りは未回答の提案があると点く", async () => {
		expect(await litVessel([proposalOf()], "提案が届いています")).toContain(
			"is-lit",
		);
	});

	it("提案の取得に失敗しても意思の一覧を表示する", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		proposalsResponse = jsonResponse(500, {
			error: { code: "INTERNAL", message: "HTTP 500", details: {} },
		});
		setup();

		expect(await screen.findByText(connectionIntent.raw_text)).toBeTruthy();
		expect(document.querySelector(".arrival")).toBeNull();
		expect(screen.queryByText("一覧を読み込めませんでした。")).toBeNull();
	});

	it("activeカードは灯り(status--lamp・glグリフ)を使わない(README §3の規定)", async () => {
		// つながり・機会のどちらのactiveも通常の墨色+gt/gm。灯りは提案が届いたとき(F4以降)のみ
		listResponse = jsonResponse(200, {
			items: [connectionIntent, occasionIntent],
			next_cursor: null,
		});
		setup();

		await screen.findByText(connectionIntent.raw_text);
		expect(document.querySelectorAll(".status--lamp").length).toBe(0);
		expect(document.querySelectorAll(".glyph .gl").length).toBe(0);
		// activeの意匠(gt/gm)は状態チップぶんだけ出る(カード左の大グリフにもgt/gmを使う)
		expect(
			document.querySelectorAll(".status .glyph .gt").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("カードにはentranceのrise基底クラスと遅延クラスを両方付ける(ボードどおり)", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent, occasionIntent, draftIntent],
			next_cursor: null,
		});
		setup();

		await screen.findByText(connectionIntent.raw_text);
		const cards = document.querySelectorAll(".intent");
		expect(cards.length).toBe(3);
		for (const card of cards) {
			// .riseがアニメーション本体・.rise-Nは遅延のみ(latch.css)。ボードは両クラスを持つ
			expect(` ${card.className} `).toContain(" rise ");
			expect(card.className).toMatch(/rise-[1-5]( |$)/);
		}
	});

	it("下書きカードは/compose?draft=<id>へのリンクで・下書き・期限切れの区分に置かれる", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent, draftIntent],
			next_cursor: null,
		});
		setup();

		const link = await screen.findByRole("link", {
			name: new RegExp(draftIntent.raw_text),
		});
		expect(link.getAttribute("href")).toBe(
			`${PATHS.compose}?draft=${draftIntent.id}`,
		);
		expect(screen.getByText("下書き・期限切れ")).toBeTruthy();
		expect(screen.getByText("下書き")).toBeTruthy();
	});

	it("一時停止中・期限切れを状態表示名で出す(01 §10対照)", async () => {
		listResponse = jsonResponse(200, {
			items: [pausedIntent, expiredIntent],
			next_cursor: null,
		});
		setup();

		expect(await screen.findByText("一時停止中")).toBeTruthy();
		expect(screen.getByText("期限切れ")).toBeTruthy();
		expect(screen.getByText("下書き・期限切れ")).toBeTruthy();
		// 預けている(active)が0件のときの件数caption
		expect(screen.getByText("いま、預けている意思はありません。")).toBeTruthy();
	});

	it("空状態はHomeEmptyボードどおりのコピーで・ひとこと置くでcomposeへ進む", async () => {
		listResponse = jsonResponse(200, { items: [], next_cursor: null });
		const router = setup();

		expect(
			await screen.findByRole("heading", {
				name: "まだ、何も置いていません。",
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				"ふと浮かんだ「繋がりたい」を、ひとことだけ置いておけます。届くまでは、待つだけです。",
			),
		).toBeTruthy();
		const put = screen.getByRole("link", { name: "ひとこと置く" });
		expect(put.getAttribute("href")).toBe(PATHS.compose);

		fireEvent.click(put);
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
	});

	it("取得に失敗したら再試行を出し・もう一度読み込むで一覧を取り直す", async () => {
		listResponse = jsonResponse(500, {
			error: { code: "INTERNAL", message: "HTTP 500", details: {} },
		});
		setup();

		expect(
			await screen.findByText("一覧を読み込めませんでした。"),
		).toBeTruthy();
		expect(intentListCalls()).toBe(1);

		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));

		expect(await screen.findByText(connectionIntent.raw_text)).toBeTruthy();
		expect(intentListCalls()).toBe(2);
	});

	it("通知がブラウザで拒否済みなら帯と[設定]を出す", async () => {
		vi.mocked(browserPushEnv.permission).mockReturnValue("denied");
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		const router = setup();

		expect(
			await screen.findByText(
				"通知がオフです。提案はアプリ内のお知らせでお伝えします。",
			),
		).toBeTruthy();
		const settings = screen.getByRole("link", { name: "設定" });
		expect(settings.getAttribute("href")).toBe(PATHS.settings);
		fireEvent.click(settings);
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.settings);
		});
	});

	it("通知が拒否済みでなければ帯を出さない", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		setup();

		expect(await screen.findByText(connectionIntent.raw_text)).toBeTruthy();
		expect(
			screen.queryByText(
				"通知がオフです。提案はアプリ内のお知らせでお伝えします。",
			),
		).toBeNull();
		expect(document.querySelector(".banner")).toBeNull();
	});
	it("activeの行は意思の詳細(/intents/<id>)へのリンクになる", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		setup();
		const link = await screen.findByRole("link", {
			name: new RegExp(connectionIntent.raw_text),
		});
		expect(link.getAttribute("href")).toBe(`/intents/${connectionIntent.id}`);
	});

	it("遷移のstate.toastを一度だけrole=statusで出す", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [
				{ pathname: PATHS.home, state: { toast: "取り下げました。" } },
			],
		});
		render(withQueryClient(<RouterProvider router={router} />));
		expect(await screen.findByText("取り下げました。")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("取り下げました。");
		await waitFor(() => expect(router.state.location.state).toBeNull());
	});
});

describe("Home(オフラインの帯)", () => {
	const BANNER = "オフラインです。最後に確かめた内容を表示しています。";

	it("オフライン中は帯を出し、通知オフの帯は出さない(オフライン優先)", async () => {
		vi.spyOn(browserPushEnv, "permission").mockReturnValue("denied");
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		setOnline(false);
		setup();
		expect(await screen.findByText(BANNER)).toBeTruthy();
		expect(screen.queryByText(/通知がオフです/)).toBeNull();
	});

	it("オンラインなら帯を出さない", async () => {
		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		setup();
		await screen.findByText("いま、1つの意思を預けています。");
		expect(screen.queryByText(BANNER)).toBeNull();
	});

	it("一覧の再取得がTypeErrorで失敗し、データがあるときは帯を出す", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 0 } },
		});
		client.setQueryData(["intents"], {
			items: [connectionIntent],
			next_cursor: null,
		});
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url === "/v1/intents?limit=50") throw new TypeError("network");
			return jsonResponse(200, { items: [], next_cursor: null });
		});
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [PATHS.home],
		});
		render(
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		expect(await screen.findByText(BANNER)).toBeTruthy();
		expect(screen.getByText(connectionIntent.raw_text)).toBeTruthy();
	});
});
