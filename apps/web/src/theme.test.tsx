import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ThemeMode, ThemeProvider, useTheme } from "./theme";

/** useThemeの値を画面へ出すプローブ(nextモードへ切り替えるボタン) */
const Probe = ({ next }: { next: ThemeMode }) => {
	const { mode, theme, setMode } = useTheme();
	return (
		<button type="button" onClick={() => setMode(next)}>
			{`${mode}:${theme}`}
		</button>
	);
};

const renderTheme = (next: ThemeMode = "dark") =>
	render(
		<ThemeProvider>
			<Probe next={next} />
		</ThemeProvider>,
	);

/** prefers-color-schemeの代替(端末設定の闇モード判定を差し替える) */
const stubMatchMedia = (matches: boolean) => {
	vi.stubGlobal("matchMedia", () => ({
		matches,
		media: "(prefers-color-scheme: dark)",
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	delete document.documentElement.dataset.theme;
});

describe("ThemeProvider", () => {
	it("既定では端末設定に従い・闇モード未指定ならlightをdata-themeへ置く", () => {
		stubMatchMedia(false);

		renderTheme();

		expect(document.documentElement.getAttribute("data-theme")).toBe("light");
		expect(screen.getByRole("button").textContent).toBe("system:light");
	});

	it("端末設定がdarkならdarkをdata-themeへ置く", () => {
		stubMatchMedia(true);

		renderTheme();

		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	});

	it("setMode('dark')でdata-themeが切り替わり・選択をlocalStorageへ保存する", () => {
		stubMatchMedia(false);

		renderTheme();
		fireEvent.click(screen.getByRole("button"));

		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
		expect(localStorage.getItem("latch.theme")).toBe("dark");
		expect(screen.getByRole("button").textContent).toBe("dark:dark");
	});

	it("端末設定がdarkでもsetMode('light')でlightへ固定できる", () => {
		stubMatchMedia(true);

		renderTheme("light");
		fireEvent.click(screen.getByRole("button"));

		expect(document.documentElement.getAttribute("data-theme")).toBe("light");
		expect(localStorage.getItem("latch.theme")).toBe("light");
	});
});
