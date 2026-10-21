/** 下部タブ(TabBar)の単体試験: 現在の頁のaria-currentと各リンク先 */

import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { TabBar } from "./TabBar";

afterEach(cleanup);

const renderTabBar = (current: "home" | "connections") => {
	const router = createMemoryRouter([
		{ path: "*", element: <TabBar current={current} /> },
	]);
	render(<RouterProvider router={router} />);
};

describe("TabBar", () => {
	it("current=connectionsでは「つながり」が現在の頁・「預けている」は/homeへのリンク", () => {
		renderTabBar("connections");
		expect(
			screen
				.getByRole("link", { name: "つながり" })
				.getAttribute("aria-current"),
		).toBe("page");
		const home = screen.getByRole("link", { name: "預けている" });
		expect(home.getAttribute("href")).toBe("/home");
		expect(home.getAttribute("aria-current")).toBeNull();
		expect(
			screen.getByRole("link", { name: "置く" }).getAttribute("href"),
		).toBe("/compose");
	});

	it("current=homeでは「預けている」が現在の頁", () => {
		renderTabBar("home");
		expect(
			screen
				.getByRole("link", { name: "預けている" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByRole("link", { name: "つながり" }).getAttribute("href"),
		).toBe("/connections");
	});
});
