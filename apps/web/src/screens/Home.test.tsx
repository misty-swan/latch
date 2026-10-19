/**
 * Home画面(ボード: Home.dc.html・HomeEmpty.dc.html)の単体試験。
 * 一覧カード(words・formラベル・状態表示名01 §10対照)・下書きカードの再開リンク・
 * 空状態のコピー・取得失敗時の再試行導線を確かめる(fetchはモック)
 * 提案が届いていますカード(arrival)はF4スコープ外のため・出ていないことも確かめる
 */

import type { IntentDTO } from "@latch/shared";
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
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";

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

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答(GET /v1/intents?limit=50) */
let listResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === "/v1/intents?limit=50") {
			return listResponse;
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

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
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
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
		// F4スコープ外の提案カードは出さない
		expect(document.querySelector(".arrival")).toBeNull();
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
		expect(fetchMock).toHaveBeenCalledTimes(1);

		listResponse = jsonResponse(200, {
			items: [connectionIntent],
			next_cursor: null,
		});
		fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));

		expect(await screen.findByText(connectionIntent.raw_text)).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
