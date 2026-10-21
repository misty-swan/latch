/**
 * 端末がオフラインかどうかの購読(F8a設計 §2.3)。
 * navigator.onLineとwindowのonline/offlineイベントをuseSyncExternalStoreで読む
 */

import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void): (() => void) => {
	window.addEventListener("online", onChange);
	window.addEventListener("offline", onChange);
	return () => {
		window.removeEventListener("online", onChange);
		window.removeEventListener("offline", onChange);
	};
};

const getSnapshot = (): boolean => navigator.onLine;

/** サーバー側の描画は無いが、念のためオンライン扱いにする */
const getServerSnapshot = (): boolean => true;

/** 端末がオンラインか(オフラインのときfalse) */
export const useOnline = (): boolean =>
	useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
