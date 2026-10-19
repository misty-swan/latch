/**
 * 起動時のセッション復元ゲート(docs/04 §3.2・authSession.restore)。
 * - restore()はアプリの起動時に1回だけ呼ぶ(単一ページ内の再マウントでは再試行しない)
 * - 復元が完了するまでは保護画面の判定ができないため・子(ルーター)の描画を抑止する
 * - 復元の失敗(失効トークン)はauthSession.restore側でlocalStorageの後始末まで行い・
 *   ここでは結果を問わず描画へ進む(未認証はRequireAuthがwelcomeへ送る)
 */

import { type ReactNode, useEffect, useState } from "react";
import { authSession } from "./session";

/** 起動時の復元(アプリの生存期間で1回) */
let restoreInFlight: Promise<boolean> | null = null;

const restoreOnce = (): Promise<boolean> => {
	restoreInFlight ??= authSession.restore();
	return restoreInFlight;
};

export function AuthGate({ children }: { children: ReactNode }) {
	// 既に復元が走っていた(=ホットリロードやテストの再マウント)なら待たずに描画する
	const [ready, setReady] = useState(restoreInFlight !== null);

	useEffect(() => {
		let mounted = true;
		restoreOnce()
			.catch(() => false)
			.then(() => {
				if (mounted) {
					setReady(true);
				}
			});
		return () => {
			mounted = false;
		};
	}, []);

	if (!ready) {
		return null;
	}
	return <>{children}</>;
}
