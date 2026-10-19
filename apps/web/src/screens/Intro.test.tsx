/**
 * Intro画面(ボード: Intro1/2/3.dc.html)の単体試験。
 * 3ステップの文言・ドット・戻る/スキップ/次への導線がボードどおりであることを確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.intro],
	});
	render(<RouterProvider router={router} />);
	return router;
};

afterEach(cleanup);

describe("Intro", () => {
	it("ステップ1(01 — 置く)をボードどおりのコピーで表示する", () => {
		setup();

		expect(screen.getByText("01 — 置く")).toBeTruthy();
		expect(
			screen.getByText(
				"まだ誰にも言っていない「繋がりたい」を、ひとこと置いておく。",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				"思ったままの文章で大丈夫です。呼びかけることも、自分を売り込むこともいりません。",
			),
		).toBeTruthy();
		expect(screen.getByLabelText("1 / 3")).toBeTruthy();
	});

	it("次へで3ステップ進み・各ステップのコピーとドットが切り替わる", () => {
		setup();

		fireEvent.click(screen.getByRole("button", { name: "次へ" }));
		expect(screen.getByText("02 — 待つ")).toBeTruthy();
		expect(screen.getByText("あとは、待つだけ。")).toBeTruthy();
		expect(screen.getByLabelText("2 / 3")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "次へ" }));
		expect(screen.getByText("03 — 届く")).toBeTruthy();
		expect(
			screen.getByText("条件がかちっと合ったときだけ、届く。"),
		).toBeTruthy();
		expect(screen.getByLabelText("3 / 3")).toBeTruthy();
	});

	it("戻る(ステップ1)はwelcomeへ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "戻る" }));
		expect(router.state.location.pathname).toBe(PATHS.welcome);
	});

	it("スキップ(ステップ1)はsigninへ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "スキップ" }));
		expect(router.state.location.pathname).toBe(PATHS.signin);
	});

	it("?step=3付きで開いた場合は3/3(届く)から始まる(サインインの戻り先)", () => {
		const router = createMemoryRouter(appRoutes, {
			initialEntries: [`${PATHS.intro}?step=3`],
		});
		render(<RouterProvider router={router} />);

		expect(screen.getByText("03 — 届く")).toBeTruthy();
		expect(screen.getByLabelText("3 / 3")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "スキップ" })).toBeNull();
	});

	it("ステップ2以降の戻るは前のステップへ・3/3のはじめるはsigninへ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("button", { name: "次へ" }));
		fireEvent.click(screen.getByRole("button", { name: "戻る" }));
		expect(screen.getByLabelText("1 / 3")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "次へ" }));
		fireEvent.click(screen.getByRole("button", { name: "次へ" }));
		fireEvent.click(screen.getByRole("link", { name: "はじめる" }));
		expect(router.state.location.pathname).toBe(PATHS.signin);
	});
});
