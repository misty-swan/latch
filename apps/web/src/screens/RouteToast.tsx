/**
 * 遷移元が渡すトースト(location.state.toast)の共通部品。
 * つながり一覧・預けている一覧・意思の詳細など、別画面から戻った直後に一言を出す画面で使う。
 */

import { useEffect, useState } from "react";
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

export function RouteToast({ text }: { text: string | null }) {
	return text === null ? null : (
		<p className="toast" role="status">
			{text}
		</p>
	);
}
