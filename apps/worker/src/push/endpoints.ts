/**
 * Web Pushの送信先ホストの許可リスト(F7b設計 §4)。
 * 購読のendpointは利用者が送ってくる値のため、既知のプッシュサービスだけを許す
 * (任意URLへのサーバー発リクエストを防ぐ)。https限定。
 */

/** 完全一致で許すホスト */
const EXACT_HOSTS: ReadonlySet<string> = new Set([
	"fcm.googleapis.com",
	"updates.push.services.mozilla.com",
]);

/** 接尾辞一致で許すホスト(先頭にサブドメインが付くもの) */
const SUFFIX_HOSTS: readonly string[] = [
	".push.apple.com",
	".notify.windows.com",
];

export const isAllowedPushEndpoint = (url: string): boolean => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	const host = parsed.hostname.toLowerCase();
	return EXACT_HOSTS.has(host) || SUFFIX_HOSTS.some((s) => host.endsWith(s));
};
