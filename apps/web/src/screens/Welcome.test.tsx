/**
 * Welcome画面(ボード: prototype/project/Welcome.dc.html)の単体試験。
 * 文言・導線がボードどおりであることを確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { appRoutes } from "../router";
import { PATHS } from "../routes/paths";

const setup = () => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.welcome],
	});
	render(<RouterProvider router={router} />);
	return router;
};

afterEach(cleanup);

describe("Welcome", () => {
	it("ボードどおりのコピーを持つ", () => {
		setup();

		expect(screen.getByText("置く · 待つ · 届く")).toBeTruthy();
		expect(
			screen.getByLabelText("繋がりたいことを、置いておけばいい。"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"「こういう人と繋がりたい」を、ひとこと預けておく場所です。合う相手が現れたときだけ、提案が届きます。",
			),
		).toBeTruthy();
		expect(screen.getByText("LATCH")).toBeTruthy();
	});

	it("はじめるでintroへ進む", () => {
		const router = setup();

		fireEvent.click(screen.getByRole("link", { name: "はじめる" }));
		expect(router.state.location.pathname).toBe(PATHS.intro);
	});

	it("アカウントをお持ちの方でsigninへ進む", () => {
		const router = setup();

		fireEvent.click(
			screen.getByRole("link", { name: "アカウントをお持ちの方" }),
		);
		expect(router.state.location.pathname).toBe(PATHS.signin);
	});
});
