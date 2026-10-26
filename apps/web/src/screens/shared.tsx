/**
 * 画面共通の紙の繊維(グレイン)。
 * 各ボード(prototype/project/*.dc.html)に同一のインラインSVGで重ねられているため・
 * 1コンポーネントにまとめて各画面から使う(見た目はlatch.cssの.grainが担う)
 */

import type { CSSProperties } from "react";

export function ScreenGrain() {
	return (
		<svg className="grain" aria-hidden="true">
			<defs>
				<filter
					id="grain"
					x="0"
					y="0"
					width="100%"
					height="100%"
					colorInterpolationFilters="sRGB"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency=".82"
						numOctaves="3"
						stitchTiles="stitch"
					/>
					<feColorMatrix
						type="matrix"
						values="0 0 0 0 .10  0 0 0 0 .13  0 0 0 0 .20  1.9 0 0 0 -.86"
					/>
				</filter>
				<filter
					id="grain-d"
					x="0"
					y="0"
					width="100%"
					height="100%"
					colorInterpolationFilters="sRGB"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency=".82"
						numOctaves="3"
						stitchTiles="stitch"
					/>
					<feColorMatrix
						type="matrix"
						values="0 0 0 0 .92  0 0 0 0 .94  0 0 0 0 1  1.9 0 0 0 -.86"
					/>
				</filter>
			</defs>
			<rect width="100%" height="100%" filter="url(#grain)" />
		</svg>
	);
}

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
export function LatchMark({
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

export function Tategaki({
	style,
	reveal = true,
}: {
	style: CSSProperties;
	/** 1文字ずつ現れる動き。はじめる流れの左の絵では画面を移るたびに繰り返さないよう外す */
	reveal?: boolean;
}) {
	return (
		<p
			className={reveal ? "tategaki reveal" : "tategaki"}
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
