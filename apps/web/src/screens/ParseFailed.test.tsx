/**
 * ParseFailed画面(ボード: ParseFailed.dc.html)の単体試験。
 * 読み解けなかったときの案内・「もう一度読み解く」(composeへ戻り文章保持)・
 * 「自分で入力する」(空の構造化値でconfirmへ・手入力モード)を確かめる(fetchはモック)
 */

import { parseResponseSchema } from "@latch/shared";
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
import { readComposeState, savePendingCompose } from "../intents/composeState";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";
const DRAFT_ID = "01J00000000000000000000000";

const setup = (path: string = PATHS.parseFailed) => {
	const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
	render(<RouterProvider router={router} />);
	return router;
};

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("parse-failed画面はAPIを呼ばない");
		}),
	);
	localStorage.clear();
	sessionStorage.clear();
	authSession.clear();
	// parse-failedは要認証ガードの内側のため・JWTを注入して置く
	authSession.setTokens("access-parse-failed", null);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

describe("ParseFailed", () => {
	it("ボードどおりの案内を持つ(引用・見出し・説明・2つのボタン・戻る)", () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		expect(screen.getByText(WORDS)).toBeTruthy();
		expect(screen.getByText("うまく読み解けませんでした。")).toBeTruthy();
		expect(
			screen.getByText(
				"通信の状態を確かめて、もう一度お試しください。条件を自分で入れて預けることもできます。",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "もう一度読み解く" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "自分で入力する" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "戻る" })).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.parseFailed);
	});

	it("もう一度読み解くでcomposeへ戻り・文章が保持されている", async () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "もう一度読み解く" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textarea.value).toBe(WORDS);
	});

	it("自分で入力するで空の構造化値を置いてconfirmへ進む(手入力モード)", async () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "自分で入力する" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.confirm);
		});
		const state = readComposeState();
		expect(state?.raw_text).toBe(WORDS);
		expect(state?.draft_id).toBeNull();
		// 空の構造化値はparse応答の契約どおり(confirmがそのまま読める)
		expect(parseResponseSchema.parse(state?.parse)).toEqual(state?.parse);
		expect(state?.parse.topic).toBe("");
		expect(state?.parse.time).toBeNull();
		expect(screen.getByText("こう読み解きました。")).toBeTruthy();
	});

	it("自分で入力するは下書きidを引き継ぐ(保存はPATCHになる)", async () => {
		savePendingCompose({ raw_text: WORDS, draft_id: DRAFT_ID });
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "自分で入力する" }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.confirm);
		});
		expect(readComposeState()?.draft_id).toBe(DRAFT_ID);
	});

	it("状態が無い直アクセスではcomposeへ送り返す", async () => {
		const router = setup();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(PATHS.compose);
		});
	});
});
