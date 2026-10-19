/**
 * Register画面(ボード: Register.dc.html)の単体試験。
 * 表示名(1..40)・生年月日の入力検証・登録APIの呼び出し・422 UNDER_AGEの表示を確かめる
 */

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

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** テストが差し替える応答 */
let usersResponse: Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === "/v1/users") {
			return usersResponse;
		}
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.register],
	});
	render(<RouterProvider router={router} />);
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
	// registerは要認証ガードの内側のため・登録前JWTを注入して置く
	authSession.setTokens("access-prereg", null);
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
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("Register", () => {
	it("ボードどおりのコピーを持ち・表示名は40字まで・生年月日のmaxは今日(JST)", () => {
		setup();

		expect(screen.getByText("あなたのことを、少しだけ。")).toBeTruthy();
		expect(
			screen.getByText(
				"つながった相手にだけ表示されます。あとから変えられます。",
			),
		).toBeTruthy();
		expect(
			screen.getByText("年齢の確認にだけ使います。誰にも表示されません。"),
		).toBeTruthy();
		expect(screen.getByText("1 / 2")).toBeTruthy();

		const name = screen.getByLabelText("表示名") as HTMLInputElement;
		expect(name.maxLength).toBe(40);
		expect(name.getAttribute("autocomplete")).toBe("nickname");
		expect(name.getAttribute("placeholder")).toBe("例: みなと");

		const birth = screen.getByLabelText("生年月日") as HTMLInputElement;
		const today = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Tokyo",
		}).format(new Date());
		expect(birth.getAttribute("max")).toBe(today);
	});

	it("空欄では送信できず・表示名の必須エラーを出す(APIも呼ばない)", async () => {
		setup();

		fireEvent.click(screen.getByRole("button", { name: "次へ" }));

		expect(await screen.findByText("表示名を入力してください")).toBeTruthy();
		expect(await screen.findByText("生年月日を入力してください")).toBeTruthy();
		await waitFor(() => {
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	it("18歳の入力でPOST /v1/usersを呼び・トークンを付け替えてconsentへ進む", async () => {
		const router = setup();

		fireEvent.change(screen.getByLabelText("表示名"), {
			target: { value: "ゆき" },
		});
		fireEvent.change(screen.getByLabelText("生年月日"), {
			target: { value: "2008-01-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "次へ" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/v1/users");
		expect(JSON.parse(init.body as string)).toEqual({
			display_name: "ゆき",
			birth_date: "2008-01-01",
		});
		expect(authSession.accessToken).toBe("access-registered");
		expect(localStorage.getItem("latch.refresh")).toBe("refresh-registered");

		expect(
			await screen.findByRole("button", { name: "同意して進む" }),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.consent);
	});

	it("422 UNDER_AGEではボード(UnderAge)どおりの表示に切り替わり・戻るとフォームに戻る", async () => {
		usersResponse = jsonResponse(422, {
			error: {
				code: "UNDER_AGE",
				message: "利用登録は18歳以上の方に限ります",
				details: {},
			},
		});
		setup();

		fireEvent.change(screen.getByLabelText("表示名"), {
			target: { value: "ゆき" },
		});
		fireEvent.change(screen.getByLabelText("生年月日"), {
			target: { value: "2009-01-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "次へ" }));

		expect(
			await screen.findByText("LATCHは、18歳以上の方のためのサービスです。"),
		).toBeTruthy();

		// 戻る(アイコン)でフォームへ戻る
		fireEvent.click(screen.getByRole("button", { name: "戻る" }));
		expect(await screen.findByText("あなたのことを、少しだけ。")).toBeTruthy();
	});
});
