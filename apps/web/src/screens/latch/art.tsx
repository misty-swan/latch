/**
 * 提案〜成立の画面で共有する絵の部品(prototype/app/app.jsの
 * latch()・dome・groupDisc()・tategaki・avatarの移植・F4c設計)。
 * Placed.tsxが同じ構造をインラインで持つが、ここでは触らない。
 */

import type { CSSProperties, Ref } from "react";

export type LatchArtState = "arrived" | "pressed" | "latched" | "ended";

type LatchArtProps = {
	state: LatchArtState;
	size: number;
	gap: number;
	className?: string;
	/** 相手側の半円の塗り(--theirs-fill) */
	theirsFill?: string;
	/** 閉じたときの波紋(latch__ring)を先頭に入れる */
	ring?: boolean;
	/** 外からclassListで状態を差し替えるためのref */
	ref?: Ref<HTMLDivElement>;
};

export function LatchArt({
	state,
	size,
	gap,
	className,
	theirsFill,
	ring,
	ref,
}: LatchArtProps) {
	const style = {
		"--size": `${size}px`,
		"--gap": `${gap}px`,
		...(theirsFill ? { "--theirs-fill": theirsFill } : {}),
	} as CSSProperties;
	return (
		<div
			ref={ref}
			className={`latch is-${state}${className ? ` ${className}` : ""}`}
			style={style}
			aria-hidden="true"
		>
			{ring ? <span className="latch__ring" /> : null}
			<span className="latch__light" />
			<span className="latch__mine" />
			<span className="latch__theirs">
				<span className="latch__ink" />
			</span>
		</div>
	);
}

type GroupDiscProps = {
	count: number;
	size: number;
	light?: boolean;
	/** 指定時は全員ぶんをg-mineにして各色で塗る */
	fills?: string[];
};

/** グループ:円を人数で割り、自分のぶんだけ墨を入れる(左が自分) */
export function GroupDisc({ count, size, light, fills }: GroupDiscProps) {
	const c = size / 2;
	const r = size / 2 - 8;
	const g = 3.4;
	const paths = Array.from({ length: count }, (_, i) => {
		const mid = Math.PI + (i * 2 * Math.PI) / count;
		const a0 = mid - Math.PI / count;
		const a1 = mid + Math.PI / count;
		const ox = Math.cos(mid) * g;
		const oy = Math.sin(mid) * g;
		const p = (a: number) =>
			`${(c + ox + r * Math.cos(a)).toFixed(2)} ${(c + oy + r * Math.sin(a)).toFixed(2)}`;
		const large = (2 * Math.PI) / count > Math.PI ? 1 : 0;
		const d = `M${(c + ox).toFixed(2)} ${(c + oy).toFixed(2)}L${p(a0)}A${r} ${r} 0 ${large} 1 ${p(a1)}Z`;
		return (
			<path
				key={d}
				className={i === 0 || fills ? "g-mine" : "g-blank"}
				d={d}
				style={fills ? { fill: fills[i] } : undefined}
			/>
		);
	});
	const sizeVar = { "--size": `${size}px` } as CSSProperties;
	return (
		<div className="group-wrap" style={sizeVar} aria-hidden="true">
			{light ? <span className="group-light" style={sizeVar} /> : null}
			{/* biome-ignore lint/a11y/noSvgWithoutTitle: 装飾(親がaria-hidden) */}
			<svg
				className="group-disc"
				width={size}
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				focusable="false"
			>
				{paths}
			</svg>
		</div>
	);
}

/** 棚に戻した絵(半ドームと棚) */
export function DomeRest({
	size,
	style,
}: {
	size: number;
	style?: CSSProperties;
}) {
	return (
		<div
			className="dome-rest"
			style={{ "--size": `${size}px`, ...style } as CSSProperties}
			aria-hidden="true"
		>
			<span className="dome" />
			<span className="shelf" />
		</div>
	);
}

type TategakiProps = {
	text: string;
	className?: string;
	style?: CSSProperties;
};

/** 縦書き。\nで改行し、1文字ずつ--iでink-inの遅延をずらす */
export function Tategaki({ text, className, style }: TategakiProps) {
	let k = 0;
	const lines = text.split("\n");
	return (
		<p
			className={`tategaki${className ? ` ${className}` : ""}`}
			style={style}
			role="img"
			aria-label={text.replace(/\n/g, "")}
		>
			<span aria-hidden="true">
				{lines.map((line, li) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 行は静的で並びが変わらない
					<span key={li}>
						{li > 0 ? <br /> : null}
						{[...line].map((ch) => {
							const i = k++;
							return (
								<span
									key={`ch-${i}`}
									className="ch"
									style={{ "--i": i } as CSSProperties}
								>
									{ch}
								</span>
							);
						})}
					</span>
				))}
			</span>
		</p>
	);
}

/** アバターの色調ごとの塗り(prototype/app/app.jsのAV・latch.cssの.avatar--Xの--c1と同値) */
export const AVATAR_TONE_FILLS = {
	b: "#6B4E2E",
	c: "#2F5A55",
	d: "#5B3F5E",
	e: "#48552F",
} as const;

type AvatarProps = {
	userId?: string;
	hasIcon: boolean;
	size: "s" | "m" | "l";
	tone: "b" | "c" | "d" | "e";
	label?: string;
};

/** アイコンがあれば画像、無ければ半円模様の無地(toneで色) */
export function Avatar({ userId, hasIcon, size, tone, label }: AvatarProps) {
	const a11y = label
		? ({ role: "img", "aria-label": label } as const)
		: ({ "aria-hidden": true } as const);
	if (hasIcon && userId) {
		return (
			<span className={`avatar avatar--${size}`} {...a11y}>
				<img
					src={`/v1/users/${userId}/icon`}
					alt=""
					style={{
						position: "absolute",
						inset: 0,
						width: "100%",
						height: "100%",
						objectFit: "cover",
						zIndex: 1,
					}}
				/>
			</span>
		);
	}
	return (
		<span className={`avatar avatar--${tone} avatar--${size}`} {...a11y} />
	);
}
