/**
 * 通知と表示(/settings・F7c設計 §1.6・§3.1)。prototype/app/app.jsのscreens.settings・
 * Settings.dc.html・PushOff.dc.htmlの移植。
 * 「意思ごとのお知らせは…」の文はF8で意思の画面ができるまで出さない(設計書 §1.6)。
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
	disablePush,
	enablePush,
	PUSH_STATUS_QUERY_KEY,
	usePushStatus,
} from "../../push/subscription";
import { PATHS } from "../../routes/paths";
import { type ThemeMode, useTheme } from "../../theme";
import { ScreenGrain } from "../shared";
import "./me.css";

const DENIED =
	"ブラウザの設定で通知がオフになっています。提案は、アプリ内のお知らせでお伝えします。";
const UNSUPPORTED =
	"このブラウザでは通知を受け取れません。提案は、アプリ内のお知らせでお伝えします。";
const NOT_ENABLED =
	"通知をオンにできませんでした。提案は、アプリ内のお知らせでお伝えします。";

const THEMES: ReadonlyArray<readonly [ThemeMode, string]> = [
	["system", "端末の設定に合わせる"],
	["light", "昼(明るい紙)"],
	["dark", "夜(暗い紙)"],
];

const BellOff = () => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M8.4 6.9a5.5 5.5 0 0 1 9.1 4.4v5.2l1.6 1.9H9.6" />
		<path d="M6.5 11.3v5.2l-1.6 1.9H15" />
		<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
		<path d="M4 4l16 16" />
	</svg>
);

export function Settings() {
	const queryClient = useQueryClient();
	const status = usePushStatus();
	const { mode, setMode } = useTheme();
	const [busy, setBusy] = useState(false);
	// 有効化したのに購読できなかったときの注意(offのまま)
	const [notEnabled, setNotEnabled] = useState(false);

	const current = status.data;
	const toggle = async (): Promise<void> => {
		if (busy || (current !== "on" && current !== "off")) return;
		setBusy(true);
		setNotEnabled(false);
		try {
			if (current === "on") {
				try {
					await disablePush();
					queryClient.setQueryData(PUSH_STATUS_QUERY_KEY, "off");
				} catch {
					// 解除の途中で失敗しても端末側の購読は外れる。実際の状態を取り直す
					await queryClient.invalidateQueries({
						queryKey: PUSH_STATUS_QUERY_KEY,
					});
				}
				return;
			}
			const next = await enablePush();
			queryClient.setQueryData(PUSH_STATUS_QUERY_KEY, next);
			if (next === "off") setNotEnabled(true);
		} finally {
			setBusy(false);
		}
	};

	const note =
		current === "denied"
			? DENIED
			: current === "unsupported"
				? UNSUPPORTED
				: notEnabled
					? NOT_ENABLED
					: null;

	return (
		<div className="screen settings">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.me} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<div className="topbar__title">通知と表示</div>
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body" style={{ paddingBottom: 28 }}>
				<h2 className="list__head t-label" style={{ paddingTop: 12 }}>
					通知
				</h2>
				<div className="pad">
					<div className="setting-row">
						<div>
							<p className="t-head">プッシュ通知</p>
							<p className="t-caption">
								提案と、つながったときだけ届きます。本文に内容は表示されません。
							</p>
						</div>
						<div className="switch">
							<input
								type="checkbox"
								aria-label="プッシュ通知"
								checked={current === "on"}
								disabled={busy || (current !== "on" && current !== "off")}
								onChange={() => void toggle()}
							/>
							<span />
						</div>
					</div>
					{note !== null && (
						<p className="note" style={{ marginTop: 12 }}>
							<BellOff />
							<span>{note}</span>
						</p>
					)}
				</div>
				<h2 className="list__head t-label" style={{ marginTop: 12 }}>
					表示
				</h2>
				<div className="pad">
					{THEMES.map(([value, label]) => (
						<label className="radio-row" key={value}>
							<input
								type="radio"
								name="theme"
								value={value}
								checked={mode === value}
								onChange={() => setMode(value)}
							/>
							<span>{label}</span>
						</label>
					))}
				</div>
			</div>
		</div>
	);
}
