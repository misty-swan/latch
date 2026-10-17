import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
	it("「LATCH」と表示する", () => {
		render(<App />);
		expect(screen.getByText("LATCH")).toBeTruthy();
	});
});
