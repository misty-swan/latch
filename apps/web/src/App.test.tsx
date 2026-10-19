import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { PATHS } from "./routes/paths";

afterEach(cleanup);

describe("App", () => {
	it("起動時にwelcomeのプレースホルダ画面を表示する", async () => {
		render(<App />);

		expect(await screen.findByText("welcome")).toBeTruthy();
	});

	it("PATHSに全画面のパスが定義されている", () => {
		expect(Object.values(PATHS)).toEqual([
			"/welcome",
			"/intro",
			"/signin",
			"/register",
			"/consent",
			"/compose",
			"/reading",
			"/confirm",
			"/parse-failed",
			"/placed",
			"/home",
		]);
	});
});
