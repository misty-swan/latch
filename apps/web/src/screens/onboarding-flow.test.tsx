/**
 * はじめる画面群の一本道(F2'計画Task 3 Step 1)。
 * welcome→signin→(テストサインイン「ゆき」)→token→registration_requiredでregisterへ /
 * 登録(18歳)→users→consent→home / 17歳で422 UNDER_AGE表示 / 登録済なら直接home。
 * fetchだけをモックし・apiFetchとルーターは実物を使う(実APIは叩かない)
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { authSession } from "../auth/session";
import { appRoutes } from "../router";

const REFRESH_KEY = "latch.refresh";
const CONSENT_KEY = "latch.consent";

/** JSON応答のResponseを作る */
const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答(各itの冒頭で設定する) */
let tokenResponse: Response;
let usersResponse: Response;

/** URLで振り分けるfetchのモック(実APIは叩かない) */
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === "/v1/dev/idp-token") {
			return jsonResponse(200, { idp_token: "dev-idp-token" });
		}
		if (url === "/v1/auth/token") {
			return tokenResponse;
		}
		if (url === "/v1/users") {
			return usersResponse;
		}
		// 着地するhome一覧(Task 6)は空で返す
		if (url === "/v1/intents?limit=50") {
			return jsonResponse(200, { items: [], next_cursor: null });
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** 指定URLへの呼び出し(1件だけの前提)のボディを取り出す */
const requestBodyOf = (url: string): unknown => {
	const calls = fetchMock.mock.calls.filter(
		([called]) => String(called) === url,
	);
	expect(calls).toHaveLength(1);
	const [, init] = calls[0] as [string, RequestInit];
	return JSON.parse(init.body as string);
};

/** 登録前(18歳)の応答群 */
const preregistrationResponses = (): void => {
	tokenResponse = jsonResponse(200, {
		access_token: "access-prereg",
		refresh_token: null,
		expires_in: 3600,
		user: null,
		registration_required: true,
	});
	usersResponse = jsonResponse(201, {
		user: {
			id: "01J00000000000000000000000",
			display_name: "ゆき",
			bio: "",
			has_icon: false,
		},
		access_token: "access-registered",
		refresh_token: "refresh-registered",
		expires_in: 3600,
	});
};

/** welcome→スキップ→サインイン→テストサインインの実行(token呼び出しまで) */
const signinViaDev = async (): Promise<void> => {
	fireEvent.click(await screen.findByRole("link", { name: "はじめる" }));
	fireEvent.click(await screen.findByRole("link", { name: "スキップ" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Googleで続ける" }),
	);
	fireEvent.change(await screen.findByLabelText("名前"), {
		target: { value: "ゆき" },
	});
	fireEvent.click(screen.getByRole("button", { name: "テストではじめる" }));
};

/** 登録フォームを埋めて次へ(登録画面の表示と・登録APIの完了まで待つ) */
const submitRegister = async (birthDate: string): Promise<void> => {
	await screen.findByLabelText("表示名");
	fireEvent.change(screen.getByLabelText("表示名"), {
		target: { value: "ゆき" },
	});
	fireEvent.change(screen.getByLabelText("生年月日"), {
		target: { value: birthDate },
	});
	fireEvent.click(screen.getByRole("button", { name: "次へ" }));
	await waitFor(() => {
		expect(
			fetchMock.mock.calls.some(([called]) => String(called) === "/v1/users"),
		).toBe(true);
	});
};

describe("はじめる画面群の一本道", () => {
	it("welcome→サインイン→登録→同意→homeまで進み・各APIの呼び出しと同意の記録が仕様どおり", async () => {
		preregistrationResponses();
		const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
		render(<App router={router} />);

		await signinViaDev();
		await submitRegister("2008-01-01");

		// 登録の成功でsub付きトークンに付け替わり・同意画面へ
		expect(authSession.accessToken).toBe("access-registered");
		fireEvent.click(
			await screen.findByRole("button", { name: "同意して進む" }),
		);

		// home(空状態)に到達する
		expect(
			await screen.findByRole("heading", {
				name: "まだ、何も置いていません。",
			}),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe("/home");

		// APIの呼び出し内容(順にdev/idp-token→auth/token→users)
		expect(requestBodyOf("/v1/dev/idp-token")).toEqual({ subject: "ゆき" });
		expect(requestBodyOf("/v1/auth/token")).toEqual({
			provider: "google",
			idp_token: "dev-idp-token",
		});
		expect(requestBodyOf("/v1/users")).toEqual({
			display_name: "ゆき",
			birth_date: "2008-01-01",
		});
		// 同意はlocalStorageに記録する
		expect(localStorage.getItem(CONSENT_KEY)).toBe("true");
		expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-registered");
	});

	it("17歳の生年月日では422 UNDER_AGEでボード(UnderAge)どおりの表示になり・閉じるでwelcomeへ戻る", async () => {
		preregistrationResponses();
		usersResponse = jsonResponse(422, {
			error: {
				code: "UNDER_AGE",
				message: "利用登録は18歳以上の方に限ります",
				details: {},
			},
		});
		const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
		render(<App router={router} />);

		await signinViaDev();
		await submitRegister("2009-01-01");

		expect(
			await screen.findByText("LATCHは、18歳以上の方のためのサービスです。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"入力された生年月日では、いまはご利用いただけません。18歳になったら、またお越しください。",
			),
		).toBeTruthy();

		// 閉じるでwelcomeへ戻る(ボードの導線どおり)
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(await screen.findByRole("link", { name: "はじめる" })).toBeTruthy();
		expect(router.state.location.pathname).toBe("/welcome");
	});

	it("登録済みユーザーのサインインでは登録を経由せず直接homeへ進む", async () => {
		tokenResponse = jsonResponse(200, {
			access_token: "access-ok",
			refresh_token: "refresh-ok",
			expires_in: 3600,
			user: {
				id: "01J00000000000000000000000",
				display_name: "ゆき",
				bio: "",
				has_icon: false,
			},
			registration_required: false,
		});
		const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
		render(<App router={router} />);

		await signinViaDev();

		expect(
			await screen.findByRole("heading", {
				name: "まだ、何も置いていません。",
			}),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe("/home");
		expect(authSession.accessToken).toBe("access-ok");
		// 登録APIは呼ばない
		expect(
			fetchMock.mock.calls.some(([called]) => String(called) === "/v1/users"),
		).toBe(false);
	});
});
