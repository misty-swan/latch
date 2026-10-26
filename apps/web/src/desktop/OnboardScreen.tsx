/**
 * ログイン前の画面をPCの2列で描く部品(LAT-14・LAT-118・PC向けの画面の設計 §2・§3)。
 * - DeskArt: 左の列(ロゴ・背景の円・中央の絵・「置く · 待つ · 届く」)。ようこそとはじめる流れで共通
 * - OnboardScreen: はじめる流れ(intro・サインイン・登録・同意)の画面の外側。PCの2列では左にDeskArt、
 *   右の列に各画面の中身(上部バー・本文・下部)を置く。それ以外ではスマホの見た目のまま描く
 */

import type { ReactNode } from "react";
import { LatchMark, ScreenGrain, Tategaki } from "../screens/shared";
import { useDesktop } from "./context";

/** 左の列。中央の絵を省くと、ようこそと同じ半円と縦書きを置く */
export function DeskArt({
	children,
	label,
	reveal = false,
}: {
	children?: ReactNode;
	/** 読み上げの名前。省くと飾りとして読み上げから外す(右の列と同じ内容を繰り返さないため) */
	label?: string;
	/** 縦書きの1文字ずつ現れる動き(ようこそだけ) */
	reveal?: boolean;
}) {
	return (
		<section
			className="welcome-desk__art"
			aria-label={label}
			aria-hidden={label === undefined ? true : undefined}
		>
			<div
				className="vessel vessel--quiet welcome-desk__vessel"
				aria-hidden="true"
			/>
			<span className="brand">
				<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
					<path className="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z" />
					<path className="mark__theirs" d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z" />
				</svg>
				<span className="brand__word">LATCH</span>
			</span>
			<div className="welcome-desk__stage">
				{children ?? (
					<>
						<LatchMark state="waiting" />
						<Tategaki
							reveal={reveal}
							style={{ fontSize: 32, lineHeight: 2.1, height: 420 }}
						/>
					</>
				)}
			</div>
			<p className="t-eyebrow" style={{ position: "relative" }}>
				置く · 待つ · 届く
			</p>
		</section>
	);
}

/** はじめる流れの画面の外側。childrenは各画面の上部バー・本文・下部(またはそれを包むform) */
export function OnboardScreen({
	className,
	label,
	art,
	children,
}: {
	/** .screen に足すクラス(スマホの見た目のときもそのまま付ける) */
	className?: string;
	/** 右の列の読み上げの名前 */
	label: string;
	/** 左の列の中央の絵。省くとようこそと同じ半円と縦書き */
	art?: ReactNode;
	children: ReactNode;
}) {
	const { landing } = useDesktop();
	const screenClass = className ? `screen ${className}` : "screen";
	if (!landing) {
		return (
			<div className={screenClass}>
				<ScreenGrain />
				{children}
			</div>
		);
	}
	return (
		<div className={`${screenClass} welcome-desk onboard-desk`}>
			<ScreenGrain />
			<DeskArt>{art}</DeskArt>
			<section className="onboard-desk__panel" aria-label={label}>
				{children}
			</section>
		</div>
	);
}
