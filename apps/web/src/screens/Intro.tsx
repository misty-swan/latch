/**
 * 3つの流れ(ボード: Intro1/2/3.dc.html の移植)。
 * ボード3枚を1画面のステップ状態として再現する(戻る/次へでステップを往復し・
 * 1の戻るはwelcome・スキップと3のはじめるはsigninへ進む)。文言・クラス名はボードどおり
 * PCの幅(1024px以上)では、左に各ステップの絵・右に文言と導線の2列で描く(LAT-118)
 */

import { type CSSProperties, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useDesktop } from "../desktop/context";
import { OnboardScreen } from "../desktop/OnboardScreen";
import { PATHS } from "../routes/paths";
import { LatchMark } from "./shared";

/** 各ステップのキャッチコピー(ボードのt-eyebrow・h1・t-bodyの順) */
const STEP_COPY: ReadonlyArray<{
	eyebrow: string;
	title: string;
	body: string;
}> = [
	{
		eyebrow: "01 — 置く",
		title: "まだ誰にも言っていない「繋がりたい」を、ひとこと置いておく。",
		body: "思ったままの文章で大丈夫です。呼びかけることも、自分を売り込むこともいりません。",
	},
	{
		eyebrow: "02 — 待つ",
		title: "あとは、待つだけ。",
		body: "届かない日は、まだ時機ではないだけ。預けた意思は、期限まで静かに置かれています。",
	},
	{
		eyebrow: "03 — 届く",
		title: "条件がかちっと合ったときだけ、届く。",
		body: "お互いが「参加する」を選んだら、はじめて相手が見えて、話せるようになります。",
	},
];

/** 戻るアイコン(ボードどおりのパス) */
const BackIcon = () => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M14.5 5.5L8 12l6.5 6.5" />
	</svg>
);

/** PCの2列の左に置く各ステップの絵(スマホの本文の絵を大きくしたもの・LAT-118)。大きさはdesktop.cssで決める */
function DeskStepArt({ step }: { step: 1 | 2 | 3 }) {
	if (step === 1) {
		return (
			<div className="dome-rest" aria-hidden="true">
				<span className="dome" />
				<span className="shelf" />
			</div>
		);
	}
	return <LatchMark state={step === 2 ? "waiting" : "arrived"} />;
}

export function Intro() {
	// サインイン画面の戻る(ボードではIntro3へ)を再現するため・?step=で初期ステップを取る
	const [searchParams] = useSearchParams();
	const initialStep = searchParams.get("step") === "3" ? 3 : 1;
	const [step, setStep] = useState<1 | 2 | 3>(initialStep);
	const { landing } = useDesktop();
	const copy = STEP_COPY[step - 1];
	const goNext = () => setStep((s) => (s === 1 ? 2 : 3));
	const goBack = () => setStep((s) => (s === 3 ? 2 : 1));

	return (
		<OnboardScreen
			className={`intro intro--${step}`}
			label="3つの流れ"
			art={<DeskStepArt step={step} />}
		>
			<header className="topbar">
				<div className="topbar__side">
					{step === 1 ? (
						<Link className="icon-btn" to={PATHS.welcome} aria-label="戻る">
							<BackIcon />
						</Link>
					) : (
						<button
							type="button"
							className="icon-btn"
							aria-label="戻る"
							onClick={goBack}
						>
							<BackIcon />
						</button>
					)}
				</div>
				<span />
				<div className="topbar__side topbar__side--end">
					{step < 3 && (
						<Link className="btn btn--quiet btn--small" to={PATHS.signin}>
							スキップ
						</Link>
					)}
				</div>
			</header>
			<div className="screen__body">
				{landing ? null : (
					<div
						className="intro__art"
						style={{ height: 330, display: "grid", placeItems: "center" }}
					>
						{step === 1 ? (
							<div
								className="dome-rest"
								style={{ "--size": "168px", marginTop: 120 } as CSSProperties}
								aria-hidden="true"
							>
								<span className="dome" />
								<span className="shelf" />
							</div>
						) : (
							<div
								className={`latch ${step === 2 ? "is-waiting" : "is-arrived"}`}
								style={{ "--size": "200px", "--gap": "18px" } as CSSProperties}
								aria-hidden="true"
							>
								<span className="latch__light" />
								<span className="latch__mine" />
								<span className="latch__theirs">
									<span className="latch__ink" />
								</span>
							</div>
						)}
					</div>
				)}
				<div className="pad">
					<p className="t-eyebrow rise">{copy.eyebrow}</p>
					<h1
						className="t-display t-display--s rise rise-1"
						style={{ marginTop: 12 }}
					>
						{copy.title}
					</h1>
					<p className="t-body rise rise-2" style={{ marginTop: 14 }}>
						{copy.body}
					</p>
				</div>
			</div>
			<div className="screen__foot">
				<div className="dots" role="img" aria-label={`${step} / 3`}>
					{([1, 2, 3] as const).map((n) => (
						<span
							key={n}
							className={n === step ? "dots__d is-on" : "dots__d"}
						/>
					))}
				</div>
				{step < 3 ? (
					<button
						type="button"
						className="btn btn--primary btn--block"
						onClick={goNext}
					>
						次へ
					</button>
				) : (
					<Link className="btn btn--primary btn--block" to={PATHS.signin}>
						はじめる
					</Link>
				)}
			</div>
		</OnboardScreen>
	);
}
