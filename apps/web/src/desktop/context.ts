/**
 * PC向けの外枠(DesktopFrame)が各画面へ渡す状態(LAT-14・PC向けの画面の設計 §2)。
 * 外枠の外(単体試験で画面だけを描くとき・スマホの幅)では既定値=すべて偽になり、各画面はスマホの見た目のまま描く
 */

import { createContext, useContext } from "react";

export type DesktopState = {
	/** 左のナビを出している(画面側の下部タブと右上の入口は出さない) */
	nav: boolean;
	/** ようこそとはじめる流れ(intro・サインイン・登録・同意)をPCの2列で描く */
	landing: boolean;
	/** 右の提案の部屋に出しているLATCHのID(出していなければnull) */
	roomLatchId: string | null;
};

export const DesktopContext = createContext<DesktopState>({
	nav: false,
	landing: false,
	roomLatchId: null,
});

export const useDesktop = (): DesktopState => useContext(DesktopContext);
