/**
 * 規約ページの共通の枠(/terms・/privacy・F7c設計 §1.10)。
 * - 冒頭(題名の直下)に「この文書は公開前の版です。」の印を置く(F7c設計 §0.2の1・公開時に外す。
 *   弁護士等の法務確認は予定していない=01冒頭の決定記録(規約と法務確認))
 * - 戻るは直前の画面へ。アプリ内の履歴が無い直接の入場(location.keyが"default")はようこそへ
 * - サインイン前から開けるため、ルートはRequireAuthの外に置く(router.tsx)
 * prototypeにボードが無いため、見た目は既存のトップバー・注記のクラスを組み合わせた実装の裁量
 */

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import "./legal.css";

export const DRAFT_MARK = "この文書は公開前の版です。";

/** 公開準備(F10)で記入する箇所の表記(運営者名・連絡先・施行日など) */
export const TBD = "公開前に記入";

export function LegalPage({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const location = useLocation();

	const back = (): void => {
		// 最初に開いた画面のキーは"default"。そのときは戻る先がアプリ内に無い
		if (location.key === "default") {
			navigate(PATHS.welcome);
			return;
		}
		navigate(-1);
	};

	return (
		<div className="screen legal">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<button
						className="icon-btn"
						type="button"
						aria-label="戻る"
						onClick={back}
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</button>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body pad legal__body">
				<h1 className="t-display t-display--s">{title}</h1>
				<p className="note note--lamp legal__mark">
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.5" />
						<path d="M12 11v5.2" />
						<circle cx="12" cy="7.9" r=".9" fill="currentColor" stroke="none" />
					</svg>
					<span>
						<b>{DRAFT_MARK}</b>
						内容は公開までに見直し、変わることがあります。
					</span>
				</p>
				{children}
			</div>
		</div>
	);
}

/** 章(見出しh2と本文) */
export function LegalSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="legal__section">
			<h2 className="t-head">{title}</h2>
			{children}
		</section>
	);
}
