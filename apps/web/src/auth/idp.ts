/**
 * 本番IdP(Google/Apple)からIDトークンを得る部品(docs/04 §4: 画面側のIdP接続)。
 * - 外部のSDK(スクリプト)は読み込まず、各IdPの認可画面へ同じタブで移動し(リダイレクト)、
 *   IDトークンをURLの#以降(fragment=サーバーへ送られない部分)で受け取る(OpenID Connectの暗黙フロー)。
 *   ボタンはprototypeどおりの自前のものを使え、ホーム画面に置いたPWAでもポップアップに頼らない
 * - 出発時にstate(取り違え・なりすましの防止)とnonce(トークンの使い回しの防止)を乱数で作って
 *   sessionStorageに置き、戻りで照合して1回で捨てる。古い出発(10分超)は受け付けない
 * - サインイン(signin)と退会の再認証(withdraw)は同じ部品で行い、戻り先の画面(/auth/callback)が
 *   出発時の目的で後の処理を分ける
 * - client idはビルド時の環境変数(VITE_GOOGLE_CLIENT_ID・VITE_APPLE_CLIENT_ID)。未設定のIdPは使えない
 * IDトークンの署名・iss・aud・期限はサーバー(POST /v1/auth/token・DELETE /v1/users/me)が確かめる。
 * ここでのnonceの照合は署名を確かめない読み取りで、画面側の取り違えの検出だけに使う
 */

import type { AuthProvider } from "@latch/shared";
import { PATHS } from "../routes/paths";

/** IDトークンを得る目的(戻り先の画面が後の処理を分ける) */
export type IdpPurpose = "signin" | "withdraw";

/** 出発時に置く控え(sessionStorage・1回で捨てる) */
interface PendingIdp {
	provider: AuthProvider;
	purpose: IdpPurpose;
	state: string;
	nonce: string;
	/** 出発の時刻(ミリ秒) */
	startedAt: number;
}

/** 戻りの照合の結果 */
export type IdpCallbackResult =
	| {
			ok: true;
			provider: AuthProvider;
			purpose: IdpPurpose;
			idToken: string;
	  }
	| {
			ok: false;
			/** 出発の控えが読めたときの目的(戻す画面を選ぶ。読めなければundefined) */
			purpose?: IdpPurpose;
			/** cancelled=利用者が取り消した・failed=それ以外(控え無し・不一致・期限切れ等) */
			reason: "cancelled" | "failed";
	  };

const PENDING_STORAGE_KEY = "latch.idp.pending";

/** 出発から戻りまでに許す時間(ミリ秒)。退会の再認証の新しさ(発行から10分・05 §3.3)にそろえる */
export const IDP_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";

/** 利用者が取り消したときに各IdPが返すerror */
const CANCELLED_ERRORS = new Set(["access_denied", "user_cancelled_authorize"]);

/** ビルド時に与えたclient id(空文字は未設定として扱う) */
export const idpClientId = (provider: AuthProvider): string | undefined => {
	const value =
		provider === "google"
			? import.meta.env.VITE_GOOGLE_CLIENT_ID
			: import.meta.env.VITE_APPLE_CLIENT_ID;
	return typeof value === "string" && value !== "" ? value : undefined;
};

/** そのIdPでサインインできるか(client idが与えられているか) */
export const isIdpConfigured = (provider: AuthProvider): boolean =>
	idpClientId(provider) !== undefined;

/** 戻り先のURL(IdPの設定に登録するリダイレクトURLと完全に一致させる・docs/runbooks/idp.md) */
export const idpRedirectUri = (origin: string = window.location.origin) =>
	`${origin}${PATHS.idpCallback}`;

/** 推測できない乱数(32バイト・base64url) */
const randomToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

/** IdPの認可画面のURL(各IdPの公式の引数・docs/04 §4) */
export const buildAuthorizeUrl = (
	provider: AuthProvider,
	params: {
		clientId: string;
		redirectUri: string;
		state: string;
		nonce: string;
	},
): string => {
	if (provider === "google") {
		const query = new URLSearchParams({
			client_id: params.clientId,
			redirect_uri: params.redirectUri,
			response_type: "id_token",
			scope: "openid",
			state: params.state,
			nonce: params.nonce,
			// 複数のアカウントを持つ人が、使うアカウントを選べるようにする
			prompt: "select_account",
		});
		return `${GOOGLE_AUTHORIZE_URL}?${query.toString()}`;
	}
	// Appleは名前・メールを求めない(scope無し)ので、fragmentで受け取れる
	// (scopeを求めるとform_post=サーバーで受ける形しか選べない)
	const query = new URLSearchParams({
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		response_type: "code id_token",
		response_mode: "fragment",
		state: params.state,
		nonce: params.nonce,
	});
	return `${APPLE_AUTHORIZE_URL}?${query.toString()}`;
};

/**
 * IdPの認可画面へ移動する。client id未設定ならfalse(移動しない)。
 * assignは試験で差し替える(既定はwindow.location.assign)
 */
export const startIdpRedirect = (
	provider: AuthProvider,
	purpose: IdpPurpose,
	assign: (url: string) => void = (url) => window.location.assign(url),
	now: () => number = Date.now,
): boolean => {
	const clientId = idpClientId(provider);
	if (clientId === undefined) {
		return false;
	}
	const pending: PendingIdp = {
		provider,
		purpose,
		state: randomToken(),
		nonce: randomToken(),
		startedAt: now(),
	};
	sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
	assign(
		buildAuthorizeUrl(provider, {
			clientId,
			redirectUri: idpRedirectUri(),
			state: pending.state,
			nonce: pending.nonce,
		}),
	);
	return true;
};

/** 出発の控えを読む(形が崩れていればnull) */
const readPending = (): PendingIdp | null => {
	const raw = sessionStorage.getItem(PENDING_STORAGE_KEY);
	if (raw === null) {
		return null;
	}
	try {
		const value = JSON.parse(raw) as Partial<PendingIdp>;
		if (
			(value.provider === "google" || value.provider === "apple") &&
			(value.purpose === "signin" || value.purpose === "withdraw") &&
			typeof value.state === "string" &&
			typeof value.nonce === "string" &&
			typeof value.startedAt === "number"
		) {
			return value as PendingIdp;
		}
		return null;
	} catch {
		return null;
	}
};

/** IDトークンのペイロードのnonceを読む(署名は確かめない・読めなければnull) */
const readNonce = (token: string): string | null => {
	const segment = token.split(".")[1];
	if (segment === undefined || segment === "") {
		return null;
	}
	try {
		const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
		const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
		const nonce =
			typeof payload === "object" && payload !== null
				? (payload as { nonce?: unknown }).nonce
				: undefined;
		return typeof nonce === "string" ? nonce : null;
	} catch {
		return null;
	}
};

/**
 * IdPからの戻り(URLの#以降)を照合する。出発の控えは結果を問わず捨てる(1回限り)。
 * stateの一致・取り消しでないこと・IDトークンがあること・nonceの一致・期限内を確かめる
 */
export const completeIdpRedirect = (
	hash: string,
	now: () => number = Date.now,
): IdpCallbackResult => {
	const pending = readPending();
	sessionStorage.removeItem(PENDING_STORAGE_KEY);
	if (pending === null) {
		return { ok: false, reason: "failed" };
	}
	const purpose = pending.purpose;
	const params = new URLSearchParams(
		hash.startsWith("#") ? hash.slice(1) : hash,
	);
	if (params.get("state") !== pending.state) {
		return { ok: false, purpose, reason: "failed" };
	}
	const error = params.get("error");
	if (error !== null) {
		return {
			ok: false,
			purpose,
			reason: CANCELLED_ERRORS.has(error) ? "cancelled" : "failed",
		};
	}
	const idToken = params.get("id_token");
	if (
		idToken === null ||
		idToken === "" ||
		readNonce(idToken) !== pending.nonce ||
		now() - pending.startedAt > IDP_PENDING_MAX_AGE_MS
	) {
		return { ok: false, purpose, reason: "failed" };
	}
	return { ok: true, provider: pending.provider, purpose, idToken };
};
