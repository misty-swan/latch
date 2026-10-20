/**
 * 画面パスの定数。docs/04 §3.2(React Router library mode)・01 §10の画面フロー。
 * ルーター・画面遷移・セッション破棄時のリダイレクト先で共有する(依存のない葉モジュール)。
 */
export const PATHS = {
	welcome: "/welcome",
	intro: "/intro",
	signin: "/signin",
	register: "/register",
	consent: "/consent",
	compose: "/compose",
	reading: "/reading",
	confirm: "/confirm",
	parseFailed: "/parse-failed",
	placed: "/placed",
	home: "/home",
	latch: "/latches/:id",
	latchShelved: "/latches/:id/shelved",
} as const;

/** 提案1件の画面(F4c設計 §1.1) */
export const latchPath = (id: string): string =>
	`/latches/${encodeURIComponent(id)}`;

/** 見送った直後の画面(F4c設計 §1.1) */
export const latchShelvedPath = (id: string): string =>
	`${latchPath(id)}/shelved`;
