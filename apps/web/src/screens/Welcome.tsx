/**
 * ようこそ画面(ボード: prototype/project/Welcome.dc.html の移植)。
 * 文言・構造・クラス名はボードどおり。導線ははじめる→intro・アカウントをお持ちの方→signin
 * 退会の直後は遷移元が渡す一言(「退会しました。」・location.state.toast)を出す
 * PCの幅(1024px以上)では、左に半円と縦書き・右に説明と導線の2列で描く(LAT-14・PC向けの画面の設計 §3)
 */

import type { CSSProperties } from "react";
import { Link } from "react-router";
import { useDesktop } from "../desktop/context";
import { PATHS } from "../routes/paths";
import { RouteToast, useRouteToast } from "./RouteToast";
import { ScreenGrain } from "./shared";

/** 縦書きの1文字ごとのspan(ボードの--i連番どおり。iは連番の位置) */
const withIndices = (
	chars: string,
	offset: number,
): Array<{ ch: string; i: number }> =>
	[...chars].map((ch, index) => ({ ch, i: offset + index }));
const TATEGAKI_FIRST_ROW = withIndices("繋がりたいことを、", 0);
const TATEGAKI_SECOND_ROW = withIndices(
	"置いておけばいい。",
	TATEGAKI_FIRST_ROW.length,
);

/** 半円(latch.cssの.latch)。大きさを省くとCSS側(desktop.css)で決める */
function LatchMark({
	state,
	size,
	gap,
}: {
	state: "draft" | "waiting" | "arrived";
	size?: number;
	gap?: number;
}) {
	return (
		<div
			className={`latch is-${state}`}
			style={
				size === undefined
					? undefined
					: ({ "--size": `${size}px`, "--gap": `${gap}px` } as CSSProperties)
			}
			aria-hidden="true"
		>
			<span className="latch__light" />
			<span className="latch__mine" />
			<span className="latch__theirs">
				<span className="latch__ink" />
			</span>
		</div>
	);
}

function Tategaki({ style }: { style: CSSProperties }) {
	return (
		<p
			className="tategaki reveal"
			role="img"
			style={style}
			aria-label="繋がりたいことを、置いておけばいい。"
		>
			<span aria-hidden="true">
				{TATEGAKI_FIRST_ROW.map((char) => (
					<span
						key={char.i}
						className="ch"
						style={{ "--i": char.i } as CSSProperties}
					>
						{char.ch}
					</span>
				))}
				<br />
				{TATEGAKI_SECOND_ROW.map((char) => (
					<span
						key={char.i}
						className="ch"
						style={{ "--i": char.i } as CSSProperties}
					>
						{char.ch}
					</span>
				))}
			</span>
		</p>
	);
}

/** 置く・待つ・届くの3段(PCの2列の右側) */
const STEPS = [
	{ state: "draft", head: "置く", text: "繋がりたいことを、ひとことで。" },
	{ state: "waiting", head: "待つ", text: "探さずに、預けたままにしておく。" },
	{
		state: "arrived",
		head: "届く",
		text: "合う相手が現れたときだけ、灯りがともる。",
	},
] as const;

/** PCの幅のようこそ画面(LAT-14) */
function WelcomeDesk({ toast }: { toast: string | null }) {
	return (
		<div className="screen welcome welcome-desk">
			<ScreenGrain />
			<section className="welcome-desk__art" aria-label="LATCHについて">
				<div
					className="vessel vessel--quiet welcome-desk__vessel"
					aria-hidden="true"
				/>
				<span className="brand">
					<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
						<path className="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z" />
						<path
							className="mark__theirs"
							d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z"
						/>
					</svg>
					<span className="brand__word">LATCH</span>
				</span>
				<div className="welcome-desk__stage">
					<LatchMark state="waiting" />
					<Tategaki style={{ fontSize: 32, lineHeight: 2.1, height: 420 }} />
				</div>
				<p className="t-eyebrow" style={{ position: "relative" }}>
					置く · 待つ · 届く
				</p>
			</section>
			<section className="welcome-desk__panel" aria-label="はじめる">
				<p className="t-eyebrow">ようこそ</p>
				<h1 className="t-display welcome-desk__title">探さなくていい。</h1>
				<p className="t-body" style={{ marginTop: 18 }}>
					「こういう人と繋がりたい」を、ひとこと預けておく場所です。合う相手が現れたときだけ、提案が届きます。
				</p>
				<ol className="welcome-desk__steps">
					{STEPS.map((step) => (
						<li key={step.head}>
							<LatchMark state={step.state} size={36} gap={4} />
							<span className="stack">
								<span className="t-head">{step.head}</span>
								<span className="t-caption">{step.text}</span>
							</span>
						</li>
					))}
				</ol>
				<div className="welcome-desk__actions">
					<Link className="btn btn--primary btn--block" to={PATHS.intro}>
						はじめる
					</Link>
					<Link className="btn btn--quiet" to={PATHS.signin}>
						アカウントをお持ちの方
					</Link>
				</div>
				<p className="t-meta welcome-desk__links">
					<Link className="link" to={PATHS.terms}>
						利用規約
					</Link>
					<Link className="link" to={PATHS.privacy}>
						プライバシーポリシー
					</Link>
					<Link className="link" to={PATHS.help}>
						ヘルプ
					</Link>
				</p>
			</section>
			<RouteToast text={toast} />
		</div>
	);
}

export function Welcome() {
	const toast = useRouteToast();
	const { landing } = useDesktop();
	if (landing) return <WelcomeDesk toast={toast} />;
	return (
		<div className="screen welcome">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<span className="brand">
						<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
							<path
								className="mark__mine"
								d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z"
							/>
							<path
								className="mark__theirs"
								d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z"
							/>
						</svg>
						<span className="brand__word">LATCH</span>
					</span>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body" style={{ overflow: "hidden" }}>
				<div style={{ position: "absolute", left: 22, top: 128 }}>
					<LatchMark state="waiting" size={252} gap={22} />
				</div>
				<Tategaki
					style={{
						position: "absolute",
						right: 30,
						top: 96,
						fontSize: 27,
						lineHeight: 2.05,
					}}
				/>
				<p
					className="t-eyebrow"
					style={{ position: "absolute", left: 24, top: 428 }}
				>
					置く · 待つ · 届く
				</p>
			</div>
			<div className="screen__foot">
				<p className="t-body" style={{ marginBottom: 10 }}>
					「こういう人と繋がりたい」を、ひとこと預けておく場所です。合う相手が現れたときだけ、提案が届きます。
				</p>
				<Link className="btn btn--primary btn--block" to={PATHS.intro}>
					はじめる
				</Link>
				<Link className="btn btn--quiet" to={PATHS.signin}>
					アカウントをお持ちの方
				</Link>
			</div>
			<RouteToast text={toast} />
		</div>
	);
}
