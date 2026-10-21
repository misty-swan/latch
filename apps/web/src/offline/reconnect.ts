/**
 * 接続の回復(F8a設計 §2.2)。
 * onlineイベントでオフライン中のセッションなら復元をやり直し、成功したら取得をやり直す。
 * サーバーが拒否したときはrestore()がclear()を通すので、端末の保存はonClearの後始末で消え、
 * ようこそ画面へ移る(通信の失敗でまだオフライン中のときは移らない)
 */

import type { QueryClient } from "@tanstack/react-query";
import { authSession } from "../auth/session";
import { PATHS } from "../routes/paths";

/** onlineイベントの監視を始める。戻り値で止める */
export const startReconnect = (
	queryClient: QueryClient,
	target: EventTarget = window,
	goWelcome: () => void = () => window.location.assign(PATHS.welcome),
): (() => void) => {
	const onOnline = (): void => {
		if (!authSession.offline) {
			return;
		}
		void authSession.restore().then((restored) => {
			if (restored) {
				void queryClient.invalidateQueries();
				return;
			}
			// 拒否(セッションは破棄済み)ならようこそ画面へ。通信の失敗ならオフラインのまま待つ
			if (!authSession.offline) {
				goWelcome();
			}
		});
	};
	target.addEventListener("online", onOnline);
	return () => {
		target.removeEventListener("online", onOnline);
	};
};
