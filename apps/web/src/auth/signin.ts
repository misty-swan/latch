/**
 * IdPのIDトークンをLATCHのセッションに替える(docs/05 §3.2: POST /v1/auth/token)。
 * テスト用サインイン(SignIn)と本番IdPの戻り(IdpCallback)が同じ処理を使う
 */

import type { AuthProvider } from "@latch/shared";
import { apiFetch } from "../api/client";
import { authSession } from "./session";

/** devサインイン(テスト鍵)が有効か(開発ビルドまたはVITE_DEV_AUTH=1・サインインと退会で共通) */
export const isDevSigninEnabled = (): boolean =>
	import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH === "1";

/** POST /v1/auth/tokenの応答(docs/05 §3.2・worker/routes/auth.tsの実装に一致) */
interface AuthTokenResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
	user: unknown;
	registration_required: boolean;
}

/** IDトークンを渡してセッションを確立する。戻り値は登録が要るか(未登録=true) */
export const signInWithIdpToken = async (
	provider: AuthProvider,
	idpToken: string,
): Promise<{ registrationRequired: boolean }> => {
	const token = await apiFetch<AuthTokenResponse>("/auth/token", {
		method: "POST",
		json: { provider, idp_token: idpToken },
	});
	authSession.setTokens(token.access_token, token.refresh_token);
	authSession.setProvider(provider);
	return { registrationRequired: token.registration_required };
};
