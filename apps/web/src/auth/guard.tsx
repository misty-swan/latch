/**
 * 未認証ガード(docs/04 §3.2・F2'計画Task 3)。
 * アクセストークンが未確立のまま保護画面へ入った場合はwelcomeへ送り返す。
 * 判定はメモリ上のトークンと、オフライン中のセッション(F8a 設計書 §2.2)
 * (起動ゲートAuthGateの後なので復元は完了済み)。オフライン中は端末に保存した内容で
 * 保護画面を描画する
 */

import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { PATHS } from "../routes/paths";
import { authSession } from "./session";

export function RequireAuth({ children }: { children: ReactNode }) {
	if (authSession.accessToken === null && !authSession.offline) {
		return <Navigate to={PATHS.welcome} replace />;
	}
	return <>{children}</>;
}
