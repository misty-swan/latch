/**
 * Confirm画面(ボード: ConfirmConnection.dc.html・ConfirmOccasion.dc.html・LimitReached.dc.html)
 * の単体試験。form切替・各条件の編集・期限・預けるのPOST/PATCH分岐・
 * サーバーエラー(422 ACTIVE_INTENT_LIMIT・400 VALIDATION_FAILED reasons)の表示・
 * 手入力モードを確かめる(fetchはモック)
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
import { readComposeState, saveComposeState } from "../intents/composeState";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";
const DRAFT_ID = "01J00000000000000000000000";

/** つながりのparse応答フィクスチャ(docs/05 §3.3) */
const connectionParse = {
	form: "connection",
	topic: "イラスト仲間",
	category: null,
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

/** 機会のparse応答フィクスチャ(日時・予算あり) */
const occasionParse = {
	form: "occasion",
	topic: "軽く飲みに行く",
	category: "食・飲み",
	time: { start: "2026-10-21T20:00:00+09:00", end: null },
	geo: null,
	participants: { min: 2, max: 4, includes_owner: true },
	budget: { min: 5000, max: 5000, currency: "JPY" },
	expires_at_options: ["2026-10-21T23:00:00+09:00"],
	alcohol_involved: true,
	warnings: [],
} satisfies ParseIntentResponse;

/** 手入力モード(parse-failedの「自分で入力する」が置く空の構造化値) */
const emptyParse = {
	form: "connection",
	topic: "",
	category: null,
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	expires_at_options: [],
	alcohol_involved: false,
	warnings: [],
} satisfies ParseIntentResponse;

const createdIntent: IntentDTO = {
	id: DRAFT_ID,
	form: "connection",
	topic: "イラスト仲間",
	category: null,
	raw_text: WORDS,
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
	status: "active",
	version: 1,
	expires_at: "2026-11-18T12:00:00+09:00",
	created_at: "2026-10-19T12:00:00+09:00",
	updated_at: "2026-10-19T12:00:00+09:00",
};

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答 */
let saveResponse: Response;
let draftResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url === "/v1/intents" && method === "POST") {
			return saveResponse;
		}
		if (url === `/v1/intents/${DRAFT_ID}` && method === "PATCH") {
			return draftResponse;
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

const setup = (path: string = PATHS.confirm) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [path],
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

/**
 * now+offset(JSTの壁時計)のdatetime-local値を作る。
 * 実時間依存を避けるため・日時を扱う試験はこの値で動かす(F2'計画Review Focus #5)
 */
const jstLocal = (offsetMs: number): string => {
	const shifted = new Date(Date.now() + offsetMs + 9 * 3_600_000);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
};

/** datetime-local値(JSTの壁時計)をAPIへ送るISO(Z)へ変換する */
const toIso = (local: string): string =>
	new Date(`${local}:00+09:00`).toISOString();

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(() => {
	// フィクスチャの日時(2026-10-21T20:00+09:00)は固定のため・現在時刻もDateだけ固定する。
	// 実時刻のままだと20:00(JST)を過ぎるとクライアント検証が先に弾き・試験が時刻で変わる
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-21T10:00:00+09:00"));
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// confirmは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-confirm", null);
	saveResponse = jsonResponse(201, createdIntent);
	draftResponse = jsonResponse(200, { ...createdIntent, version: 2 });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("Confirm(ボードどおりの表示)", () => {
	it("つながりのparse結果をこう読み解きました。として示す(引用・預け方・条件・期限)", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		expect(screen.getByText("こう読み解きました。")).toBeTruthy();
		expect(screen.getByText(WORDS)).toBeTruthy();
		expect(screen.getByRole("link", { name: "文章を直す" })).toBeTruthy();
		expect(
			screen.getByRole("radio", { name: /^つながりとして預ける/ }),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("radio", {
					name: /^つながりとして預ける/,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		expect(screen.getByText("イラスト仲間")).toBeTruthy();
		expect(screen.getByText("指定なし(全国)")).toBeTruthy();
		expect(screen.getByText("2人(あなたと相手)")).toBeTruthy();
		expect(screen.getByRole("button", { name: "条件を足す" })).toBeTruthy();
		expect(
			(screen.getByRole("radio", { name: /^30\s*日$/ }) as HTMLInputElement)
				.checked,
		).toBe(true);
		expect(screen.getByRole("radio", { name: /^7\s*日$/ })).toBeTruthy();
		expect(screen.getByRole("radio", { name: /^90\s*日$/ })).toBeTruthy();
		expect(
			screen.getByText("11月18日まで預けます。期限が来たら、お知らせします。"),
		).toBeTruthy();
		expect(
			screen.getByText("文章そのものは、相手にも表示されません。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "預ける" })).toBeTruthy();
		// つながりには日時・場所・予算・お酒の行が無い(ボードConfirmConnectionどおり)
		expect(screen.queryByText("日時")).toBeNull();
		expect(screen.queryByText("場所")).toBeNull();
		expect(screen.queryByText("予算")).toBeNull();
		expect(screen.queryByLabelText("お酒を含む")).toBeNull();
	});

	it("機会のparse結果は日時・場所・人数・予算・お酒の行と自動期限を持つ", () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: occasionParse });
		setup();

		expect(
			(
				screen.getByRole("radio", {
					name: /^機会として預ける/,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		expect(screen.getByText("日時")).toBeTruthy();
		expect(screen.getByText("場所")).toBeTruthy();
		expect(screen.getByText("2〜4人")).toBeTruthy();
		expect(screen.getByText("5,000円以内")).toBeTruthy();
		expect(screen.getByLabelText("お酒を含む")).toBeTruthy();
		expect(screen.getByText("含む")).toBeTruthy();
		expect(screen.getByText("20歳以上の方どうしでだけ届きます。")).toBeTruthy();
		expect(screen.getByText(/^開始から3時間後\(.+\)まで$/)).toBeTruthy();
		expect(
			screen.getByText("機会の期限は、日時から自動で決まります。"),
		).toBeTruthy();
		// 機会には期限日のpillsが無い(期限は日時から自動)
		expect(screen.queryByRole("radio", { name: /^30\s*日$/ })).toBeNull();
	});

	it("状態が無い直アクセスではcomposeへ送り返す", async () => {
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Confirm(form切替)", () => {
	it("機会→つながりで日時欄が消え・期限のpillsに替わる", () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: occasionParse });
		const router = setup();

		fireEvent.click(screen.getByLabelText("日時を直す"));
		const timeInput = screen.getByLabelText("日時") as HTMLInputElement;
		expect(timeInput.type).toBe("datetime-local");
		expect(timeInput.value).toBe("2026-10-21T20:00");

		fireEvent.click(
			screen.getByRole("radio", { name: /^つながりとして預ける/ }),
		);
		expect(router.state.location.pathname).toBe(PATHS.confirm);
		expect(screen.queryByLabelText("日時")).toBeNull();
		expect(screen.queryByText("日時")).toBeNull();
		expect(screen.queryByText("予算")).toBeNull();
		expect(screen.queryByLabelText("お酒を含む")).toBeNull();
		expect(screen.getByRole("radio", { name: /^30\s*日$/ })).toBeTruthy();
		// 機会のparseには期限日の選択肢が無いため・now+30日へ倒した日付で案内される
		expect(
			screen.getByText(/まで預けます。期限が来たら、お知らせします。/),
		).toBeTruthy();
	});

	it("つながり→機会で日時欄が現れ・期限のpillsが消える", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		fireEvent.click(screen.getByRole("radio", { name: /^機会として預ける/ }));
		expect(screen.getByText("日時")).toBeTruthy();
		expect(screen.queryByRole("radio", { name: /^30\s*日$/ })).toBeNull();
		// 期限は日時から自動のため・日時が空のうちは案内のみ
		expect(
			screen.getByText("機会の期限は、日時から自動で決まります。"),
		).toBeTruthy();
		expect(screen.queryByText(/^開始から3時間後/)).toBeNull();
	});

	it("つながりで足した条件は・機会へ切替えて預ける際には送らない(機会に条件行は無いため)", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "条件を足す" }));
		const input = screen.getByLabelText("条件を入力") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "初心者歓迎" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			screen.getByRole("button", { name: "初心者歓迎を外す" }),
		).toBeTruthy();

		// 機会へ切替ると条件は空になる(戻しても復活しない)
		fireEvent.click(screen.getByRole("radio", { name: /^機会として預ける/ }));
		fireEvent.click(
			screen.getByRole("radio", { name: /^つながりとして預ける/ }),
		);
		expect(
			screen.queryByRole("button", { name: "初心者歓迎を外す" }),
		).toBeNull();

		// 機会のまま日時を入れて預けると・条件は空配列で送られる
		fireEvent.click(screen.getByRole("radio", { name: /^機会として預ける/ }));
		fireEvent.click(screen.getByLabelText("日時を直す"));
		fireEvent.change(screen.getByLabelText("日時"), {
			target: { value: jstLocal(26 * HOUR_MS) },
		});
		fireEvent.blur(screen.getByLabelText("日時"));
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.form).toBe("occasion");
		expect(body.soft_constraints).toEqual([]);
	});
});

describe("Confirm(条件の編集)", () => {
	it("主題は40字まで入力でき・41字は入らない", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		fireEvent.click(screen.getByRole("button", { name: "主題を直す" }));
		const input = screen.getByLabelText("主題") as HTMLInputElement;
		expect(input.maxLength).toBe(LIMITS.TOPIC_MAX_LENGTH);

		fireEvent.change(input, { target: { value: "あ".repeat(41) } });
		// この環境(maxlengthを迂回した入力になる)では41字がそのまま入る
		expect(input.value.length).toBe(LIMITS.TOPIC_MAX_LENGTH + 1);
		fireEvent.blur(input);
		// 確定で40字超は跳ね返され・前の主題のまま(属性を迂回しても40字まで)
		expect(screen.getByText("イラスト仲間")).toBeTruthy();
		expect(screen.queryByText("あ".repeat(41))).toBeNull();

		// ふつうに直せる(Enterで確定)
		fireEvent.click(screen.getByRole("button", { name: "主題を直す" }));
		const retry = screen.getByLabelText("主題") as HTMLInputElement;
		fireEvent.change(retry, { target: { value: "新しい主題" } });
		fireEvent.keyDown(retry, { key: "Enter" });
		expect(screen.getByText("新しい主題")).toBeTruthy();
	});

	it("条件chipsを足して・外せる", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		fireEvent.click(screen.getByRole("button", { name: "条件を足す" }));
		const input = screen.getByLabelText("条件を入力") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "初心者歓迎" } });
		fireEvent.keyDown(input, { key: "Enter" });

		const chip = screen.getByRole("button", { name: "初心者歓迎を外す" });
		expect(chip).toBeTruthy();

		fireEvent.click(chip);
		expect(
			screen.queryByRole("button", { name: "初心者歓迎を外す" }),
		).toBeNull();
	});

	it("人数は2〜4人の範囲で編集でき・表示が替わる", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		fireEvent.click(screen.getByRole("button", { name: "人数を直す" }));
		// 下限は2が下端
		expect(
			(
				screen.getByRole("button", {
					name: "下限を減らす",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "上限を増やす" }));
		fireEvent.click(screen.getByRole("button", { name: "人数を閉じる" }));
		expect(screen.getByText("2〜3人")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "人数を直す" }));
		fireEvent.click(screen.getByRole("button", { name: "上限を増やす" }));
		// 上限は4が上端
		expect(
			(
				screen.getByRole("button", {
					name: "上限を増やす",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "人数を閉じる" }));
		expect(screen.getByText("2〜4人")).toBeTruthy();
	});
});

describe("Confirm(期限の選択)", () => {
	it("既定は30日で・選ぶと期限日の案内が替わる", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		setup();

		expect(
			screen.getByText("11月18日まで預けます。期限が来たら、お知らせします。"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: /^7\s*日$/ }));
		expect(
			screen.getByText("10月26日まで預けます。期限が来たら、お知らせします。"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: /^90\s*日$/ }));
		expect(
			screen.getByText("1月17日まで預けます。期限が来たら、お知らせします。"),
		).toBeTruthy();
	});
});

describe("Confirm(オフライン)", () => {
	it("預けるの通信失敗(TypeError)でオフラインの案内を出す", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		setup();
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"オフラインのため、いまは操作できません。",
		);
	});
});

describe("Confirm(預ける・保存)", () => {
	it("つながりの新規保存はPOST /v1/intents(status=active・expires_in_days)で/placedへ進む", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			form: "connection",
			topic: "イラスト仲間",
			category: null,
			time: null,
			geo: null,
			participants: { min: 2, max: 2, includes_owner: true },
			budget: null,
			hard_constraints: [],
			soft_constraints: [],
			negative_constraints: [],
			notification_level: "proposals_only",
			alcohol_involved: false,
			raw_text: WORDS,
			status: "active",
			expires_in_days: 30,
		});
		// 受け渡し状態は預けた画面のeffectで消費される(遷移直後には残っていることがある)
		await waitFor(() => {
			expect(readComposeState()).toBeNull();
		});
	});

	it("機会の保存は編集した日時・予算・お酒を運び・期限はstart+3時間", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: occasionParse });
		const router = setup();

		fireEvent.click(screen.getByLabelText("日時を直す"));
		const next = jstLocal(26 * HOUR_MS);
		fireEvent.change(screen.getByLabelText("日時"), {
			target: { value: next },
		});
		fireEvent.blur(screen.getByLabelText("日時"));

		fireEvent.click(screen.getByRole("button", { name: "予算を直す" }));
		fireEvent.change(screen.getByLabelText("予算の上限(円)"), {
			target: { value: "3000" },
		});
		fireEvent.blur(screen.getByLabelText("予算の上限(円)"));
		expect(screen.getByText("3,000円以内")).toBeTruthy();

		fireEvent.click(screen.getByLabelText("お酒を含む"));
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			form: "occasion",
			topic: "軽く飲みに行く",
			category: "食・飲み",
			time: { start: toIso(next), end: null },
			geo: null,
			participants: { min: 2, max: 4, includes_owner: true },
			budget: { min: 3000, max: 3000, currency: "JPY" },
			hard_constraints: [],
			soft_constraints: [],
			negative_constraints: [],
			notification_level: "proposals_only",
			alcohol_involved: false,
			raw_text: WORDS,
			status: "active",
			expires_at: new Date(
				new Date(`${next}:00+09:00`).getTime() + 3 * HOUR_MS,
			).toISOString(),
		});
	});

	it("下書きの再開ではPATCH(既存id)でactive化する", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: DRAFT_ID,
			parse: connectionParse,
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/v1/intents/${DRAFT_ID}`);
		expect(init.method).toBe("PATCH");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.status).toBe("active");
		expect(body.expires_in_days).toBe(30);
		expect(body.raw_text).toBe(WORDS);
		// クライアントはversionを送らない(楽観ロックはサーバー側の判定)
		expect("version" in body).toBe(false);
	});

	it("手入力モードでは空欄のまま預けられず・主題を入れると保存できる", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: emptyParse });
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		expect(await screen.findByText("主題を入力してください")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(router.state.location.pathname).toBe(PATHS.confirm);

		fireEvent.click(screen.getByRole("button", { name: "主題を直す" }));
		const input = screen.getByLabelText("主題") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "図書館で一緒に勉強したい" } });
		fireEvent.blur(input);
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.topic).toBe("図書館で一緒に勉強したい");
		expect(body.status).toBe("active");
		expect(body.time).toBeNull();
	});

	it("機会で日時が空・過去・7日超えのままでは保存せず案内を出す", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: { ...occasionParse, time: null, expires_at_options: [] },
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		expect(
			await screen.findByText("日時を入力してください。機会は日時が必須です"),
		).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByLabelText("日時を直す"));
		fireEvent.change(screen.getByLabelText("日時"), {
			target: { value: jstLocal(-HOUR_MS) },
		});
		fireEvent.blur(screen.getByLabelText("日時"));
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		expect(
			await screen.findByText("日時は現在以降で指定してください"),
		).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByLabelText("日時を直す"));
		fireEvent.change(screen.getByLabelText("日時"), {
			target: { value: jstLocal(8 * DAY_MS) },
		});
		fireEvent.blur(screen.getByLabelText("日時"));
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		expect(
			await screen.findByText("日時は現在から7日以内で指定してください"),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.confirm);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Confirm(サーバーエラーの表示)", () => {
	it("400 VALIDATION_FAILEDはreasonsを人間向けに表示する(未知の理由コードはコードのまま)", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: occasionParse });
		saveResponse = jsonResponse(400, {
			error: {
				code: "VALIDATION_FAILED",
				message: "検証に失敗しました",
				details: { reasons: ["starts_at_required", "unknown_reason"] },
			},
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		expect(
			await screen.findByText("日時を入力してください。機会は日時が必須です"),
		).toBeTruthy();
		expect(screen.getByText("unknown_reason")).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.confirm);
	});

	it("422 ACTIVE_INTENT_LIMITはボードどおりの上限シートを出し・下書きに残せる", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		saveResponse = jsonResponse(422, {
			error: {
				code: "ACTIVE_INTENT_LIMIT",
				message: "同時に預けておけるのは5つまでです",
				details: {},
			},
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		expect(
			await screen.findByText("同時に預けておけるのは、5つまでです。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"いま預けている意思のどれかを一時停止するか、取り下げると、新しく預けられます。この内容は下書きに残せます。",
			),
		).toBeTruthy();

		// 下書きの保存は別リクエストのため・応答を成功へ替える
		saveResponse = jsonResponse(201, { ...createdIntent, status: "draft" });
		fireEvent.click(screen.getByRole("button", { name: "下書きに残す" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
		const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(url).toBe("/v1/intents");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			status: "draft",
			raw_text: WORDS,
		});
	});

	it("422 ACTIVE_INTENT_LIMITで預けている一覧へを押すと保存せずhomeへ進む", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		saveResponse = jsonResponse(422, {
			error: {
				code: "ACTIVE_INTENT_LIMIT",
				message: "同時に預けておけるのは5つまでです",
				details: {},
			},
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		await screen.findByText("同時に預けておけるのは、5つまでです。");

		fireEvent.click(screen.getByRole("button", { name: "預けている一覧へ" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
		// 着地したhomeの一覧取得(limit=50)と提案取得・右上の取得のみが追加で走り・保存の再試行はされない
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(5);
		});
		const listCall = fetchMock.mock.calls.find(
			([u]) => String(u) === "/v1/intents?limit=50",
		) as [string, RequestInit | undefined];
		expect(listCall).toBeDefined();
		expect(listCall[1]?.method ?? "GET").toBe("GET");
	});
});

describe("Confirm(お酒と年齢・F7c設計 §1.9)", () => {
	it("422 ALCOHOL_RESTRICTEDでボードどおりの案内を出して預けるを止め・お酒をオフにすると押せる", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse: occasionParse });
		saveResponse = jsonResponse(422, {
			error: {
				code: "ALCOHOL_RESTRICTED",
				message: "お酒を含む機会は20歳以上のみ",
				details: {},
			},
		});
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "預ける" }));

		// 行の下の注記と足元の注記の2か所に出る(ボードAlcoholRestricted)
		await waitFor(() => {
			expect(
				screen.getAllByText("お酒を含む機会は、20歳以上の方が預けられます。"),
			).toHaveLength(2);
		});
		expect(document.body.textContent).toContain(
			"「お酒」をオフにすると、このまま預けられます。",
		);
		// 汎用のエラー行は出さない
		expect(document.body.textContent).not.toContain("ALCOHOL_RESTRICTED");
		const place = screen.getByRole("button", { name: "預ける" });
		expect((place as HTMLButtonElement).disabled).toBe(true);
		expect(router.state.location.pathname).toBe(PATHS.confirm);

		fireEvent.click(screen.getByLabelText("お酒を含む"));

		expect(
			screen.queryAllByText("お酒を含む機会は、20歳以上の方が預けられます。"),
		).toHaveLength(0);
		expect(
			(screen.getByRole("button", { name: "預ける" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);

		saveResponse = jsonResponse(201, createdIntent);
		fireEvent.click(screen.getByRole("button", { name: "預ける" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.placed);
		});
	});
});

describe("Confirm(導線)", () => {
	it("文章を直すでcomposeへ戻り・文章が保持されている", async () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: connectionParse,
		});
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "文章を直す" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		const textarea = screen.getByLabelText(
			`繋がりたいこと(${LIMITS.RAW_TEXT_MAX_LENGTH}字まで)`,
		) as HTMLTextAreaElement;
		expect(textarea.value).toBe(WORDS);
	});
});
