/**
 * 成立しませんでした画面(表示のみ・prototype/app/app.js screens.closed・
 * NotEstablished.dc.html)。終了済み・見つからないも同じ構成で見出しだけ変える。
 */

import { Link } from "react-router";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { DomeRest } from "./art";

type Variant = "closed" | "ended" | "not_found";

const HEADINGS: Record<Variant, string> = {
	closed: "この提案は成立しませんでした。",
	ended: "このつながりは終了しました。",
	not_found: "この提案は見つかりませんでした。",
};

export function NotEstablished({
	variant,
	notice = null,
	chatTo,
}: {
	variant: Variant;
	/** 送信失敗の一文(取り直しでこの表示へ移っても残す・F4c設計 §1.4) */
	notice?: string | null;
	/** 終了したつながりのチャットへの行き先(endedのときだけ[チャットを見る]を出す・F6b設計 §1.3) */
	chatTo?: string;
}) {
	return (
		<div className="screen closed">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.home} aria-label="閉じる">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body">
				<div style={{ position: "relative", height: 330 }}>
					<DomeRest
						size={132}
						style={{
							position: "absolute",
							left: "50%",
							top: 170,
							transform: "translateX(-50%)",
						}}
					/>
				</div>
				<div className="pad">
					<h1 className="t-display t-display--s rise">{HEADINGS[variant]}</h1>
					{variant !== "not_found" ? (
						<p className="t-body rise rise-1" style={{ marginTop: 12 }}>
							あなたの意思は、そのまま預けています。
						</p>
					) : null}
				</div>
			</div>
			<div className="screen__foot">
				{notice !== null ? (
					<p className="t-caption" role="alert">
						{notice}
					</p>
				) : null}
				{variant === "ended" && chatTo ? (
					<Link className="btn btn--primary btn--block" to={chatTo}>
						チャットを見る
					</Link>
				) : null}
				<Link className="btn btn--secondary btn--block" to={PATHS.home}>
					預けている一覧へ
				</Link>
			</div>
		</div>
	);
}
