/**
 * テーマ(docs/04 §3.2・prototypeのREADME)。
 * data-theme="light"/"dark"を<html>へ設定する。既定は端末設定(prefers-color-scheme)に
 * 従い・明示的な選択はlocalStorage(latch.theme)に保存する
 * (設定画面の「端末の設定に合わせる/昼/夜」に対応する)。
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "latch.theme";
const PREFERS_DARK = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
	/** 選択中のモード(端末の設定に合わせる/昼/夜) */
	mode: ThemeMode;
	/** 実際に適用されているテーマ */
	theme: ResolvedTheme;
	setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const isThemeMode = (value: string | null): value is ThemeMode =>
	value === "system" || value === "light" || value === "dark";

const readStoredMode = (): ThemeMode => {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (isThemeMode(stored)) {
			return stored;
		}
	} catch {
		// localStorageが使えない環境では端末設定に従う
	}
	return "system";
};

const systemTheme = (): ResolvedTheme =>
	window.matchMedia(PREFERS_DARK).matches ? "dark" : "light";

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
	const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
	const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

	// 端末設定の変化に追従する(モードがsystemのときのみ効く)
	useEffect(() => {
		const media = window.matchMedia(PREFERS_DARK);
		const onChange = (event: MediaQueryListEvent) => {
			setSystem(event.matches ? "dark" : "light");
		};
		media.addEventListener("change", onChange);
		return () => {
			media.removeEventListener("change", onChange);
		};
	}, []);

	const theme = mode === "system" ? system : mode;

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	const setMode = useCallback((next: ThemeMode) => {
		setModeState(next);
		try {
			localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// 保存できない環境では選択が持続しないだけとする
		}
	}, []);

	const value = useMemo(
		() => ({ mode, theme, setMode }),
		[mode, theme, setMode],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
};

export const useTheme = (): ThemeContextValue => {
	const value = useContext(ThemeContext);
	if (value === null) {
		throw new Error("useThemeはThemeProviderの内側で使ってください");
	}
	return value;
};
