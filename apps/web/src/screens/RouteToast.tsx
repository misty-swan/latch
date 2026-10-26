/**
 * 遷移元が渡すトースト(location.state.toast)の共通部品。
 * つながり一覧・預けている一覧・意思の詳細など、別画面から戻った直後に一言を出す画面で使う。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/** トーストを出しておく時間(Shelved.tsxと同じ) */
const TOAST_MS = 2400;

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
/** 下の操作(フッターのボタン・タブバー)とトーストのあいだに空ける幅 */
const TOAST_GAP = 16;

/**
 * トーストを置く高さ(見えている範囲の下端からの距離)を決める。
 * 実配信の .screen は内容に合わせて縦に伸びる(screens.css の min-height)ため、
 * latch.css の .toast(.screenの下端から120px)のままだとスクロールの先に置かれ、
 * 短い画面では下の操作と重なる(LAT-110)。見えている下の操作があればその上に置く
 */
function toastBottom(toast: HTMLElement): number {
	const screenEl = toast.closest(".screen");
	if (screenEl === null) return TOAST_BOTTOM;
	const viewportHeight = window.innerHeight;
	let bottom = TOAST_BOTTOM;
	for (const el of screenEl.querySelectorAll(".screen__foot, .tabbar")) {
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
