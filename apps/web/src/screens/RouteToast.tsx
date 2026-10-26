/**
 * トーストの共通部品。
 * 遷移元が渡す一言(location.state.toast)を出す useRouteToast と、トーストを見えている範囲に
 * 置く RouteToast からなる。RouteToast は画面の中で出す一言(見送った画面・チャットなど)にも使う。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/** トーストを出しておく時間(prototype toast()) */
export const TOAST_MS = 2400;

/** 遷移元が渡したトースト(location.state.toast)を一度だけ出す。再読み込み・戻るで再表示しない */
export function useRouteToast(): string | null {
	const location = useLocation();
	const navigate = useNavigate();
	const incoming = (location.state as { toast?: unknown } | null)?.toast;
	const [toast, setToast] = useState<string | null>(
		typeof incoming === "string" ? incoming : null,
	);
	useEffect(() => {
		if (typeof incoming !== "string") return;
		setToast(incoming);
		navigate(location.pathname, { replace: true, state: null });
	}, [incoming, location.pathname, navigate]);
	useEffect(() => {
		if (toast === null) return;
		const t = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(t);
	}, [toast]);
	return toast;
}

/** 下の操作が見えていないときの下端からの位置(latch.css .toast の bottom と同じ) */
const TOAST_BOTTOM = 120;
/** 下の操作(フッターのボタン・タブバー・チャットの入力欄と終了の帯)とトーストのあいだに空ける幅 */
const TOAST_GAP = 16;

/** 下の操作。チャットの入力欄は書きかけの文で最大140pxまで伸びる(LAT-112) */
const BOTTOM_CONTROLS = ".screen__foot, .tabbar, .composer, .ended-bar";

/**
 * トーストを置く高さ(見えている範囲の下端からの距離)を決める。
 * latch.css の .toast は .screen の下端から120pxに置くため、.screen が見えている範囲より
 * 長いとスクロールの先に置かれ、下の操作が高い画面ではそれと重なる(LAT-110・LAT-112)。
 * 見えている範囲に固定したうえで、見えている下の操作の上に置く
 */
function toastBottom(toast: HTMLElement): number {
	const screenEl = toast.closest(".screen");
	if (screenEl === null) return TOAST_BOTTOM;
	const viewportHeight = window.innerHeight;
	let bottom = TOAST_BOTTOM;
	for (const el of screenEl.querySelectorAll(BOTTOM_CONTROLS)) {
		const rect = el.getBoundingClientRect();
		if (rect.height === 0 || rect.top >= viewportHeight) continue;
		bottom = Math.max(bottom, viewportHeight - rect.top + TOAST_GAP);
	}
	return bottom;
}

export function RouteToast({ text }: { text: string | null }) {
	const ref = useRef<HTMLParagraphElement>(null);
	const [bottom, setBottom] = useState<number | null>(null);
	// 出す瞬間(描画の前)に一度だけ測る。出している約2.4秒のあいだは置き直さない
	useLayoutEffect(() => {
		if (text === null || ref.current === null) return;
		setBottom(toastBottom(ref.current));
	}, [text]);
	return text === null ? null : (
		<p
			ref={ref}
			className="toast toast--viewport"
			role="status"
			style={bottom === null ? undefined : { bottom }}
		>
			{text}
		</p>
	);
}
