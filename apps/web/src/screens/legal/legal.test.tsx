/**
 * 規約ページ(/terms・/privacy・F7c設計 §1.10)の単体試験。
 * 未ログインで開けること・冒頭の草案の印・必須の記載(08 §10)・戻るの行き先を確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authSession } from "../../auth/session";
import { appRoutes } from "../../router";
import { PATHS } from "../../routes/paths";
import { withQueryClient } from "../../test/helpers";

const DRAFT_MARK = "この文書は法務確認前の草案です。";

const setup = (entries: string[]) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: entries,
		initialIndex: entries.length - 1,
	});
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

beforeEach(() => {
	// 未ログイン(トークンなし)で開けることを確かめる
	authSession.clear();
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	authSession.clear();
});

describe("利用規約(/terms)", () => {
	it("未ログインで開け・草案の印と規制領域の禁止・クレジットを持つ", () => {
		const router = setup([PATHS.terms]);

		expect(router.state.location.pathname).toBe(PATHS.terms);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"利用規約",
		);
		expect(screen.getByText(DRAFT_MARK)).toBeTruthy();
		const text = document.body.textContent ?? "";
		for (const word of [
			"18歳以上",
			"転職",
			"職業安定法",
			"売買",
			"古物営業法",
			"交際",
			"営業",
			"虚偽の通報",
			"アイコン",
			"退会",
			"位置参照情報",
			"CC BY 2.0 JP",
			"駅データ.jp",
			"CC BY 4.0",
			"法務確認時に確定",
		]) {
			expect(text).toContain(word);
		}
	});

	it("直接開いたときの戻るはようこそへ進む", () => {
		const router = setup([PATHS.terms]);

		fireEvent.click(screen.getByRole("button", { name: "戻る" }));

		expect(router.state.location.pathname).toBe(PATHS.welcome);
	});

	it("サインインから開いたときの戻るは直前の画面へ戻る", async () => {
		const router = setup([PATHS.signin, PATHS.terms]);

		fireEvent.click(screen.getByRole("button", { name: "戻る" }));

		await screen.findByText("はじめに、アカウントをつくります。");
		expect(router.state.location.pathname).toBe(PATHS.signin);
	});
});

describe("プライバシーポリシー(/privacy)", () => {
	it("未ログインで開け・草案の印と外部AI事業者への送信・7日の保持を持つ", () => {
		const router = setup([PATHS.privacy]);

		expect(router.state.location.pathname).toBe(PATHS.privacy);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"プライバシーポリシー",
		);
		expect(screen.getByText(DRAFT_MARK)).toBeTruthy();
		const text = document.body.textContent ?? "";
		for (const word of [
			"外部AI事業者",
			"Anthropic",
			"委託",
			"第三者提供",
			"成立する前",
			"7日",
			"退会",
			"開示",
			"法務確認時に確定",
		]) {
			expect(text).toContain(word);
		}
		// 保存は中心と範囲のまま。約1kmの丸めは相手への地名の表示だけ(05 §2.2・08 §4)
		expect(text).not.toContain("約1kmの区画に丸めて扱います");
		expect(text).toContain("中心と範囲");
		// 退会で消すのは本人を含む提案の履歴だけ(05 §2.5)。「提案の記録」を広く消すとは書かない
		expect(text).not.toContain("提案の記録、");
		expect(text).toContain("再提案を避けるための提案の履歴");
	});
});
