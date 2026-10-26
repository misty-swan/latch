/**
 * ようこそ画面(ボード: prototype/project/Welcome.dc.html の移植)。
 * 文言・構造・クラス名はボードどおり。導線ははじめる→intro・アカウントをお持ちの方→signin
 * 退会の直後は遷移元が渡す一言(「退会しました。」・location.state.toast)を出す
 */

import type { CSSProperties } from "react";
import { Link } from "react-router";
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

export function Welcome() {
	const toast = useRouteToast();
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
					<div
						className="latch is-waiting"
						style={{ "--size": "252px", "--gap": "22px" } as CSSProperties}
						aria-hidden="true"
					>
						<span className="latch__light" />
						<span className="latch__mine" />
						<span className="latch__theirs">
							<span className="latch__ink" />
						</span>
					</div>
				</div>
				<p
					className="tategaki reveal"
					role="img"
					style={{
						position: "absolute",
						right: 30,
						top: 96,
						fontSize: 27,
						lineHeight: 2.05,
					}}
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
