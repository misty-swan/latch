/**
 * 認証セッション(docs/04 §4・05 §3.2)。
 * - アクセストークンはメモリのみに置く(localStorageへ残さない)
 * - リフレッシュトークンは回転式でlocalStorage(latch.refresh)に置く
 * - restore()は起動時の復元(保存済みリフレッシュトークンでリフレッシュを試みる)
 *   サーバーの明示拒否(401等)のときだけ保存値を除去し・通信失敗では残す
 *   (一時的なオフラインで有効なトークンを消さないため)
 * - refresh()は同時多発の401を単一フライトに収束させる
 * リフレッシュの呼び出しは生のfetchを直接使う(apiFetchを経由しない=循環と無限ループの構造的防止)。
 * リフレッシュ失敗時のセッション破棄と遷移は呼び出し側(apiFetch)が判断する
 */

const REFRESH_STORAGE_KEY = "latch.refresh";
const REFRESH_ENDPOINT = "/v1/auth/refresh";
const LOGOUT_ENDPOINT = "/v1/auth/logout";

/** POST /v1/auth/refreshの応答(docs/05 §3.2・workerの実装に一致) */
interface RefreshResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
}

/**
 * リフレッシュ1回の結果。
 * - success: 応答を受け・新しいトークンを得た
 * - rejected: 応答は受けたがサーバーが明示拒否(!ok)=保存値が無効と判断できる
 * - network_error: fetch例外・応答本文が読めない等で判断できない(一時的なオフライン含む)
 */
type RefreshOutcome = "success" | "rejected" | "network_error";

let accessToken: string | null = null;
let refreshInFlight: Promise<RefreshOutcome> | null = null;

const readStoredRefreshToken = (): string | null =>
	localStorage.getItem(REFRESH_STORAGE_KEY);

/** リフレッシュを1回実行する(成功時は回転後のトークンで上書きする) */
const performRefresh = async (): Promise<RefreshOutcome> => {
	const stored = readStoredRefreshToken();
	if (stored === null) {
		return "rejected";
	}
	let response: Response;
	try {
		response = await fetch(REFRESH_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: stored }),
		});
	} catch {
		// 通信失敗(一時的なオフライン等)。トークンの有効性は判断できない
		return "network_error";
	}
	if (!response.ok) {
		// サーバーが明示拒否(401等)=保存値は無効
		return "rejected";
	}
	try {
		const data = (await response.json()) as RefreshResponse;
		if (typeof data.access_token !== "string" || data.access_token === "") {
			// 応答が期待どおりでない=判断できない(拒否とは限らない)
			return "network_error";
		}
		accessToken = data.access_token;
		if (data.refresh_token !== null) {
			localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh_token);
		}
		return "success";
	} catch {
		// 応答本文が読めない(ゲートウェイのHTML応答等)。判断できないため保存値は残す
		return "network_error";
	}
};

/** 同時呼び出しを1回のリフレッシュに束ねる(単一フライト) */
const refreshOutcome = (): Promise<RefreshOutcome> => {
	refreshInFlight ??= performRefresh().finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
};

/** リフレッシュの成否(apiFetch用の真偽値。失敗の理由は問わない) */
const refreshTokens = (): Promise<boolean> =>
	refreshOutcome().then((outcome) => outcome === "success");

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
	/**
	 * ログアウト。後始末(beforeClear・Pushの購読解除等)を待ち→APIへrefresh_tokenを付けて
	 * 失効を依頼し→セッションを破棄する。APIはアクセストークンを要するため破棄より先に呼ぶ。
	 * beforeClearやAPIの失敗は無視し・必ずclear()まで進む(端末側のログアウトを妨げない)。
	 * apiFetchは使わない(循環の防止・401時のwelcome遷移と二重にならないため)
	 */
	async logout(beforeClear?: () => Promise<void>): Promise<void> {
		try {
			await beforeClear?.();
		} catch {
			// 後始末の失敗でログアウトを止めない
		}
		try {
			const send = (): Promise<Response> => {
				const stored = readStoredRefreshToken();
				return fetch(LOGOUT_ENDPOINT, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(accessToken === null
							? {}
							: { Authorization: `Bearer ${accessToken}` }),
					},
					body: JSON.stringify(
						stored === null ? {} : { refresh_token: stored },
					),
				});
			};
			// アクセストークンが無い・切れている(401)ときは1回だけリフレッシュして再試行する
			// (サーバーのlogoutは認証が必要で・失敗するとリフレッシュトークンが生き残るため)。
			// リフレッシュで回転するので・再試行時の本文は回転後の保存値から作り直す
			if (accessToken === null && readStoredRefreshToken() !== null) {
				await refreshTokens();
			}
			const response = await send();
			if (response.status === 401 && (await refreshTokens())) {
				await send();
			}
		} catch {
			// 通信失敗でも端末側の破棄は行う
		}
		authSession.clear();
	},
	/**
	 * 起動時の復元。保存済みリフレッシュトークンがあればリフレッシュを試みる。
	 * サーバーの明示拒否(401等)のときだけlocalStorageのトークンを除去する
	 * (失効済みの保存値による無駄な再試行の防止)。通信失敗では保存値を残し・
	 * 次回の起動時に再試行する(一時的なオフラインで有効なセッションを消さない)
	 */
	restore(): Promise<boolean> {
		if (readStoredRefreshToken() === null) {
			return Promise.resolve(false);
		}
		return refreshOutcome().then((outcome) => {
			if (outcome === "success") {
				return true;
			}
			if (outcome === "rejected") {
				localStorage.removeItem(REFRESH_STORAGE_KEY);
			}
			return false;
		});
	},
	/** リフレッシュトークンを回転させる(同時呼び出しは単一フライトに収束) */
	refresh: refreshTokens,
};
