/**
 * 認証セッション(docs/04 §4・05 §3.2)。
 * - アクセストークンはメモリのみに置く(localStorageへ残さない)
 * - リフレッシュトークンは回転式でlocalStorage(latch.refresh)に置く
 * - restore()は起動時の復元(保存済みリフレッシュトークンでリフレッシュを試みる)
 * - refresh()は同時多発の401を単一フライトに収束させる
 * リフレッシュの呼び出しは生のfetchを直接使う(apiFetchを経由しない=循環と無限ループの構造的防止)。
 * リフレッシュ失敗時のセッション破棄と遷移は呼び出し側(apiFetch)が判断する
 */

const REFRESH_STORAGE_KEY = "latch.refresh";
const REFRESH_ENDPOINT = "/v1/auth/refresh";

/** POST /v1/auth/refreshの応答(docs/05 §3.2・workerの実装に一致) */
interface RefreshResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
}

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

const readStoredRefreshToken = (): string | null =>
	localStorage.getItem(REFRESH_STORAGE_KEY);

/** リフレッシュを1回実行する(成功時は回転後のトークンで上書きする) */
const performRefresh = async (): Promise<boolean> => {
	const stored = readStoredRefreshToken();
	if (stored === null) {
		return false;
	}
	try {
		const response = await fetch(REFRESH_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: stored }),
		});
		if (!response.ok) {
			return false;
		}
		const data = (await response.json()) as RefreshResponse;
		if (typeof data.access_token !== "string" || data.access_token === "") {
			return false;
		}
		accessToken = data.access_token;
		if (data.refresh_token !== null) {
			localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh_token);
		}
		return true;
	} catch {
		// ネットワーク異常・応答の欠落もリフレッシュ失敗として扱う
		return false;
	}
};

/** 同時呼び出しを1回のリフレッシュに束ねる(単一フライト) */
const refreshTokens = (): Promise<boolean> => {
	refreshInFlight ??= performRefresh().finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
};

export const authSession = {
	/** メモリ上のアクセストークン(未取得はnull) */
	get accessToken(): string | null {
		return accessToken;
	},
	/** トークンを設定する。refreshTokenがnullのとき保存値は変更しない */
	setTokens(nextAccessToken: string, nextRefreshToken: string | null): void {
		accessToken = nextAccessToken;
		if (nextRefreshToken !== null) {
			localStorage.setItem(REFRESH_STORAGE_KEY, nextRefreshToken);
		}
	},
	/** セッションを破棄する(メモリとlocalStorageの両方) */
	clear(): void {
		accessToken = null;
		localStorage.removeItem(REFRESH_STORAGE_KEY);
	},
	/** 起動時の復元。保存済みリフレッシュトークンがあればリフレッシュを試みる */
	restore(): Promise<boolean> {
		return readStoredRefreshToken() === null
			? Promise.resolve(false)
			: refreshTokens();
	},
	/** リフレッシュトークンを回転させる(同時呼び出しは単一フライトに収束) */
	refresh: refreshTokens,
};
