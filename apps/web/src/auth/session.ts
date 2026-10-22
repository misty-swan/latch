/**
 * 認証セッション(docs/04 §4・05 §3.2)。
 * - アクセストークンはメモリのみに置く(localStorageへ残さない)
 * - リフレッシュトークンは回転式でlocalStorage(latch.refresh)に置く
 * - restore()は起動時の復元(保存済みリフレッシュトークンでリフレッシュを試みる)
 *   サーバーの明示拒否(401またはLATCH形式の400(VALIDATION_FAILED))のときだけ保存値を除去し・通信失敗では残す
 *   (一時的なオフラインで有効なトークンを消さないため)
 * - refresh()は同時多発の401を単一フライトに収束させる
 * リフレッシュの呼び出しは生のfetchを直接使う(apiFetchを経由しない=循環と無限ループの構造的防止)。
 * リフレッシュ失敗時のセッション破棄と遷移は呼び出し側(apiFetch)が判断する
 * (refreshOutcome()で通信失敗と明示拒否を見分ける)
 * F8a(設計書 §2.2):
 * - 最後に確立したアクセストークンのsubを利用者IDとしてlocalStorage(latch.uid)に置く
 *   (端末に保存した内容をその利用者に紐づけるための識別子のみ)
 * - 保存済みリフレッシュトークンがあり通信失敗で復元できなかったときを
 *   「オフライン中のセッション」(offline)とし、保護画面の描画を許す
 * - clear()の最後に登録されたlistenerを呼ぶ(端末に保存した内容の破棄に使う)
 * - 保存した利用者IDと異なる利用者のトークンを得たらonUserChangeのlistenerを呼ぶ(同上)
 */

const REFRESH_STORAGE_KEY = "latch.refresh";
const USER_ID_STORAGE_KEY = "latch.uid";
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
 * - rejected: サーバーの明示の拒否=401、または400で本文のerror.codeがVALIDATION_FAILED(LATCH形式)。保存値が無効と判断できる
 * - network_error: fetch例外・応答本文が読めない等で判断できない(一時的なオフライン含む)。
 *   中継の404・408・429・5xx・LATCH形式でない400もここへ入れる(保存値を捨てない)
 */
export type RefreshOutcome = "success" | "rejected" | "network_error";

let accessToken: string | null = null;
let accessUserId: string | null = null;
let offline = false;
let refreshInFlight: Promise<RefreshOutcome> | null = null;
const clearListeners = new Set<() => void>();
const userChangeListeners = new Set<() => void>();

const readStoredRefreshToken = (): string | null =>
	localStorage.getItem(REFRESH_STORAGE_KEY);

/**
 * JWTのペイロードからsubを読む。署名は検証しない
 * (端末に保存した内容を紐づけるための識別子として使うだけで、認可の判断には使わない)。
 * 形が崩れたトークンは投げずにnullを返す
 */
const readSubject = (token: string): string | null => {
	const segment = token.split(".")[1];
	if (segment === undefined || segment === "") {
		return null;
	}
	try {
		const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
		const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof payload !== "object" || payload === null) {
			return null;
		}
		const sub = (payload as { sub?: unknown }).sub;
		return typeof sub === "string" && sub !== "" ? sub : null;
	} catch {
		return null;
	}
};

/** listenerを順に呼ぶ(配列へ写してから回す・投げても他のlistenerと呼び出し元を止めない) */
const notify = (listeners: ReadonlySet<() => void>): void => {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// 後始末の失敗で呼び出し元の処理や他のlistenerを止めない
		}
	}
};

/**
 * アクセストークンを置き換え、そのsubを利用者IDとして保存する。
 * 戻り値は利用者が変わったか(前に保存した利用者IDがあり、新しいsubと異なる・または読めない)。
 * 呼び出し側はトークンの保存を終えてからnotifyUserChangeを呼ぶ
 */
const applyAccessToken = (token: string): boolean => {
	const previousUserId = localStorage.getItem(USER_ID_STORAGE_KEY);
	accessToken = token;
	accessUserId = readSubject(token);
	const userChanged =
		previousUserId !== null && previousUserId !== accessUserId;
	if (accessUserId === null) {
		// 読めないときは古い利用者IDを残さない(別の利用者の保存内容と取り違えないため)
		localStorage.removeItem(USER_ID_STORAGE_KEY);
	} else {
		localStorage.setItem(USER_ID_STORAGE_KEY, accessUserId);
	}
	return userChanged;
};

/** 利用者が変わったときに登録されたlistenerを呼ぶ(別の利用者の保存内容を消すため) */
const notifyUserChange = (userChanged: boolean): void => {
	if (userChanged) {
		notify(userChangeListeners);
	}
};

/** 400の本文がLATCHのエラー形式で、error.codeがVALIDATION_FAILEDか(読めなければfalse) */
const isValidationFailed = async (response: Response): Promise<boolean> => {
	try {
		const body: unknown = await response.json();
		const error =
			typeof body === "object" && body !== null
				? (body as { error?: unknown }).error
				: undefined;
		return (
			typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "VALIDATION_FAILED"
		);
	} catch {
		return false;
	}
};

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
		// 保存値が無効と判断できるのは401とLATCH形式の400(VALIDATION_FAILED)だけ。
		// 中継の404・5xx等では有効なトークンを捨てない
		if (response.status === 401) {
			return "rejected";
		}
		if (response.status === 400 && (await isValidationFailed(response))) {
			return "rejected";
		}
		return "network_error";
	}
	try {
		const data = (await response.json()) as RefreshResponse;
		if (typeof data.access_token !== "string" || data.access_token === "") {
			// 応答が期待どおりでない=判断できない(拒否とは限らない)
			return "network_error";
		}
		const userChanged = applyAccessToken(data.access_token);
		// apiFetch経由のリフレッシュで回復した場合もオフライン中のセッションを解く
		offline = false;
		if (data.refresh_token !== null) {
			localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh_token);
		}
		notifyUserChange(userChanged);
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
	/**
	 * 利用者ID(アクセストークンのsub)。アクセストークンが無いとき(起動直後・オフライン中)は
	 * 最後に保存した値を返す。端末の保存内容の紐づけ用で、認可の判断には使わない
	 */
	get userId(): string | null {
		if (accessToken !== null) {
			return accessUserId;
		}
		return localStorage.getItem(USER_ID_STORAGE_KEY);
	},
	/** オフライン中のセッション(直近のrestore()が通信失敗で、保存済みリフレッシュトークンがある) */
	get offline(): boolean {
		return offline && readStoredRefreshToken() !== null;
	},
	/** clear()の最後に呼ぶlistenerを登録する。戻り値で解除する */
	onClear(listener: () => void): () => void {
		clearListeners.add(listener);
		return () => {
			clearListeners.delete(listener);
		};
	},
	/**
	 * 利用者が変わったとき(前に保存した利用者IDと新しいトークンのsubが異なる)に呼ぶlistenerを登録する。
	 * トークンの保存を終えてから呼ぶ。戻り値で解除する(F8a設計 §2.1・別の利用者でのサインイン)
	 */
	onUserChange(listener: () => void): () => void {
		userChangeListeners.add(listener);
		return () => {
			userChangeListeners.delete(listener);
		};
	},
	/** トークンを設定する。refreshTokenがnullのとき保存値は変更しない */
	setTokens(nextAccessToken: string, nextRefreshToken: string | null): void {
		const userChanged = applyAccessToken(nextAccessToken);
		// トークンを得た=オフライン中のセッションではない(接続の回復時の無駄な復元を防ぐ)
		offline = false;
		if (nextRefreshToken !== null) {
			localStorage.setItem(REFRESH_STORAGE_KEY, nextRefreshToken);
		}
		notifyUserChange(userChanged);
	},
	/**
	 * セッションを破棄する(メモリとlocalStorageの両方)。最後に登録されたlistenerを呼ぶ。
	 * listenerが投げても破棄は済んでおり、他のlistenerも呼ぶ
	 */
	clear(): void {
		accessToken = null;
		accessUserId = null;
		offline = false;
		localStorage.removeItem(REFRESH_STORAGE_KEY);
		localStorage.removeItem(USER_ID_STORAGE_KEY);
		notify(clearListeners);
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
	 * サーバーの明示拒否(401またはLATCH形式の400(VALIDATION_FAILED))のときだけlocalStorageのトークンを除去する
	 * (失効済みの保存値による無駄な再試行の防止)。通信失敗では保存値を残し・
	 * 次回の起動時・接続の回復時に再試行する(一時的なオフラインで有効なセッションを消さない)。
	 * 通信失敗のときはオフライン中のセッションとし、成功・拒否で解く。
	 * 拒否はclear()を通して破棄する(端末の保存内容もlistenerで消すため)
	 */
	restore(): Promise<boolean> {
		if (readStoredRefreshToken() === null) {
			offline = false;
			return Promise.resolve(false);
		}
		return refreshOutcome().then((outcome) => {
			if (outcome === "success") {
				offline = false;
				return true;
			}
			if (outcome === "rejected") {
				authSession.clear();
				return false;
			}
			offline = true;
			return false;
		});
	},
	/** リフレッシュトークンを回転させる(同時呼び出しは単一フライトに収束) */
	refresh: refreshTokens,
	/**
	 * refresh()と同じリフレッシュ(単一フライトを共有)を行い、結果の理由まで返す。
	 * apiFetchが通信失敗(network_error)と明示拒否(rejected)を分けるために使う(F8a設計 §2.2)
	 */
	refreshOutcome,
};
