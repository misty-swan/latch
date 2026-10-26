/**
 * PC向けの画面の幅の区切り(LAT-14・PC向けの画面の設計 §1)と、その購読。
 * 区切りの値は desktop.css の @media と同じにする
 */

import { useCallback, useSyncExternalStore } from "react";

/** スマホの見た目のまま中央の列に寄せる幅(試作の外枠 shell.css が端末の枠を外す820pxの次) */
export const WIDE_QUERY = "(min-width: 821px)";
/** 左のナビを出す幅。ようこそとはじめる流れはこの幅から2列で描く */
export const DESK_QUERY = "(min-width: 1024px)";
/** 右の提案の部屋を出す幅 */
export const ROOM_QUERY = "(min-width: 1280px)";

/** 幅の条件に合っているか。matchMediaの無い環境(単体試験のjsdom)では常に偽 */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const list = window.matchMedia?.(query);
			if (!list) return () => {};
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia?.(query).matches === true,
	);
}
