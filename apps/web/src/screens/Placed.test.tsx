/**
 * Placed画面(ボード: Placed.dc.html)の単体試験。
 * 預けた演出(縦書き・latch is-waiting)・composeStateの消費・
 * 「預けている一覧へ」と数秒後の自動遷移でhomeへ進むことを確かめる(fetchはモック)
 */

import type { ParseIntentResponse } from "@latch/shared";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import { readComposeState, saveComposeState } from "../intents/composeState";
import { browserPushEnv, enablePush } from "../push/subscription";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";
import { withQueryClient } from "../test/helpers";

// 購読の手順そのものはsubscription.test.tsで確かめるため・ここではenablePushだけを差し替える
vi.mock("../push/subscription", async (importOriginal) => ({
	...(await importOriginal<typeof import("../push/subscription")>()),
	enablePush: vi.fn(async () => "on"),
}));

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";

const parse = {
	form: "connection",
	topic: "イラスト仲間",
	category: null,
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	expires_at_options: ["2026-11-18T12:00:00+09:00"],
	alcohol_involved: false,
	warnings: [],
} satisfies ParseIntentResponse;

/** 着地するhome一覧(Task 6)は空で返す(fetchの実体は使わない) */
const fetchMock = vi.fn(
	async (): Promise<Response> =>
		new Response(JSON.stringify({ items: [], next_cursor: null }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
);

const setup = (path: string = PATHS.placed) => {
	const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
	const utils = render(withQueryClient(<RouterProvider router={router} />));
	return { router, container: utils.container };
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// placedは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-placed", null);
	// 既定はこの端末でまだ通知の許可を聞いていない状態
	vi.spyOn(browserPushEnv, "permission").mockReturnValue("default");
	vi.mocked(enablePush).mockClear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("Placed", () => {
	it("ボードどおりの演出を持つ(預けた文章・縦書き・latch・コピー・push-ask)", () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { container } = setup();

		expect(screen.getByText(WORDS)).toBeTruthy();
		const tategaki = container.querySelector(".tategaki");
		expect(tategaki).toBeTruthy();
		expect(tategaki?.getAttribute("aria-label")).toBe("預けました。");
		expect(tategaki?.querySelectorAll(".ch").length).toBe(6);
		expect(container.querySelector(".latch.is-waiting")).toBeTruthy();
		expect(screen.getByText("あとは、待つだけ。")).toBeTruthy();
		expect(
			screen.getByText(
				"合う相手が現れたときだけ、お知らせします。届かない日も、意思はここに置かれています。",
			),
		).toBeTruthy();
		expect(
			screen.getByText("届いたとき、通知でお知らせしましょうか。"),
		).toBeTruthy();
		expect(
			screen.getByText("通知には、意思の内容も相手のことも表示されません。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "通知を受け取る" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "あとで" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "預けている一覧へ" })).toBeTruthy();
	});

	it("composeStateを消費して破棄する(次の預け入れに残骸を残さない)", () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		setup();

		expect(readComposeState()).toBeNull();
	});

	it("預けている一覧へでhomeへ進む", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { router } = setup();

		fireEvent.click(screen.getByRole("link", { name: "預けている一覧へ" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
	});

	it("数秒後に自動でhomeへ進む", () => {
		vi.useFakeTimers();
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { router } = setup();
		expect(router.state.location.pathname).toBe(PATHS.placed);

		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		expect(router.state.location.pathname).toBe(PATHS.home);
	});

	it("[通知を受け取る]はenablePushを待ってからhomeへ進む", async () => {
		let finish: (value: "on") => void = () => {};
		vi.mocked(enablePush).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { router } = setup();

		fireEvent.click(screen.getByRole("button", { name: "通知を受け取る" }));
		expect(enablePush).toHaveBeenCalledTimes(1);
		expect(router.state.location.pathname).toBe(PATHS.placed);
		await act(async () => {
			finish("on");
		});
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
	});

	it("[通知を受け取る]の手順のあいだは自動で進まない", async () => {
		vi.useFakeTimers();
		vi.mocked(enablePush).mockImplementation(() => new Promise(() => {}));
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { router } = setup();

		fireEvent.click(screen.getByRole("button", { name: "通知を受け取る" }));
		act(() => {
			vi.advanceTimersByTime(10_000);
		});
		expect(router.state.location.pathname).toBe(PATHS.placed);
	});

	it("[あとで]は購読せずhomeへ進む", async () => {
		saveComposeState({ raw_text: WORDS, draft_id: null, parse });
		const { router } = setup();

		fireEvent.click(screen.getByRole("button", { name: "あとで" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
		expect(enablePush).not.toHaveBeenCalled();
	});

	it.each(["denied", "unsupported", "granted"] as const)(
		"許可が%sの端末ではpush-askを出さない",
		(permission) => {
			vi.mocked(browserPushEnv.permission).mockReturnValue(permission);
			saveComposeState({ raw_text: WORDS, draft_id: null, parse });
			const { container } = setup();

			expect(container.querySelector(".push-ask")).toBeNull();
			expect(
				screen.queryByRole("button", { name: "通知を受け取る" }),
			).toBeNull();
			expect(
				screen.getByRole("link", { name: "預けている一覧へ" }),
			).toBeTruthy();
		},
	);

	it("状態が無い直アクセスではhomeへ送り返す", async () => {
		const { router } = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.home);
		});
	});
});
