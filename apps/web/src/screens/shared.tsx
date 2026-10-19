/**
 * 画面共通の紙の繊維(グレイン)。
 * 各ボード(prototype/project/*.dc.html)に同一のインラインSVGで重ねられているため・
 * 1コンポーネントにまとめて各画面から使う(見た目はlatch.cssの.grainが担う)
 */

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
