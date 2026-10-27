/**
 * 画面パスの定数。docs/04 §3.2(React Router library mode)・01 §10の画面フロー。
 * ルーター・画面遷移・セッション破棄時のリダイレクト先で共有する(依存のない葉モジュール)。
 */
export const PATHS = {
	welcome: "/welcome",
	intro: "/intro",
	signin: "/signin",
	// 本番IdP(Google/Apple)からの戻り先(docs/04 §4・IdPに登録するリダイレクトURL)
	idpCallback: "/auth/callback",
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
	connections: "/connections",
	chat: "/latches/:id/chat",
	intent: "/intents/:id",
	intentEdit: "/intents/:id/edit",
	notices: "/notices",
	me: "/me",
	profile: "/me/profile",
	withdraw: "/me/withdraw",
	settings: "/settings",
	blocked: "/settings/blocked",
	report: "/latches/:id/report",
	terms: "/terms",
	privacy: "/privacy",
	help: "/help",
} as const;

/** 提案1件の画面(F4c設計 §1.1) */
export const latchPath = (id: string): string =>
	`/latches/${encodeURIComponent(id)}`;

/** 見送った直後の画面(F4c設計 §1.1) */
export const latchShelvedPath = (id: string): string =>
	`${latchPath(id)}/shelved`;

/** チャット画面(F6b設計 §1.3) */
export const chatPath = (id: string): string => `${latchPath(id)}/chat`;

/** 通報画面。発言を対象にするときは発言IDと発言者を問い合わせ文字列で渡す */
export const reportPath = (
	id: string,
	message?: { messageId: string; userId: string },
): string => {
	const base = `${latchPath(id)}/report`;
	if (!message) return base;
	return `${base}?message=${encodeURIComponent(message.messageId)}&user=${encodeURIComponent(message.userId)}`;
};

/** 意思の詳細画面(F8a設計) */
export const intentPath = (id: string): string =>
	`/intents/${encodeURIComponent(id)}`;

/** 意思を直す画面(F8a設計) */
export const intentEditPath = (id: string): string => `${intentPath(id)}/edit`;
