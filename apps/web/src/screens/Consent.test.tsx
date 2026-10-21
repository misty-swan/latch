/**
 * Consent画面(ボード: Consent.dc.html)の単体試験。
 * docs/07 §8の3系統文言がボードどおりであること・同意の記録と導線を確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";

/** 同意後の着地はcomposeで・compose自体はfetchしない(home遷移時の一覧用に残す) */
const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
	const url = String(input);
	if (url === "/v1/intents?limit=50") {
		return jsonResponse(200, { items: [], next_cursor: null });
	}
	throw new Error(`想定外のfetch: ${url}`);
});

/** consentは要認証ガードの内側のため・トークンを注入して置く */
const setup = () => {
	authSession.setTokens("access-1", null);
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.consent],
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	authSession.clear();
	vi.unstubAllGlobals();
});

describe("Consent", () => {
	it("ボードどおりの3系統(docs/07 §8)の文言と注意書きを持つ", () => {
		setup();

		expect(screen.getByText("預けた言葉の、扱いについて。")).toBeTruthy();
		expect(screen.getByText("読み解き")).toBeTruthy();
		expect(
			screen.getByText(
				"入力した文章を、意思の解析のためそのまま外部AI事業者(Anthropic)へ送信します(学習利用はありません)",
			),
		).toBeTruthy();
		expect(screen.getByText("成立の判定")).toBeTruthy();
		expect(
			screen.getByText(
				"相手との成立判定のため、預けた意思から生成したテキストを外部AI事業者(TypeSafe・緊急時はAnthropic)へ送信します(入力原文は送りません・学習利用はありません)",
			),
		).toBeTruthy();
		expect(screen.getByText("意味の近さの計算")).toBeTruthy();
		expect(
			screen.getByText(
				"意味検索の埋め込み計算はCloudflare内で行われ、外部送信はありません",
			),
		).toBeTruthy();
		expect(screen.getByText("01")).toBeTruthy();
		expect(screen.getByText("02")).toBeTruthy();
		expect(screen.getByText("03")).toBeTruthy();
		expect(screen.getByText("預けた文章そのものが、")).toBeTruthy();
		expect(
			screen.getByText("ほかの利用者に表示されることはありません。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"同意しない場合、意思を預けることはできません。閲覧と設定はできます。",
			),
		).toBeTruthy();
		expect(screen.getByText("2 / 2")).toBeTruthy();
	});

	it("同意して進むでlatch.consent=trueを記録しcompose(最初の1件を預ける導線)へ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "同意して進む" }));

		expect(router.state.location.pathname).toBe(PATHS.compose);
		expect(localStorage.getItem("latch.consent")).toBe("true");
	});

	it("同意しないで進むでは記録せずhomeへ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "同意しないで進む" }));

		expect(router.state.location.pathname).toBe(PATHS.home);
		expect(localStorage.getItem("latch.consent")).toBeNull();
	});

	it("?view=1では[同意して進む]を出さず・戻るは/meへ", () => {
		authSession.setTokens("access-1", null);
		const router = createMemoryRouter(appRoutes, {
			initialEntries: ["/consent?view=1"],
		});
		render(withQueryClient(<RouterProvider router={router} />));

		expect(screen.queryByText("同意して進む")).toBeNull();
		expect(
			screen.getByRole("link", { name: "戻る" }).getAttribute("href"),
		).toBe(PATHS.me);
	});
});
