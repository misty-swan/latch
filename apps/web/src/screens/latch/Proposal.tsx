/**
 * 提案画面(表示のみ・prototype/app/app.js screens.proposal・Proposal.dc.html・
 * ProposalGroup.dc.html・F4c設計)。取得と回答は親(Task 6)が担い・ここは
 * propsだけで描く。回答UIはyes/deferの2択(noはUIに置かない・docs/02 §4)。
 * Awaiting.tsxも同じ枠(ProposalFrame)を使う。
 */

import type { LatchDTO } from "@latch/shared";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { Link } from "react-router";
import { formatLeft, formatWhen } from "../../latches/format";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { GroupDisc, LatchArt } from "./art";

/** 残り時間の再描画間隔(prototypeの15000ms) */
const TICK_MS = 15_000;

type FrameProps = {
	latch: LatchDTO;
	now: Date;
	/** 回答待ち(押した状態)の絵・見出しにする */
	pressed: boolean;
	text: ReactNode;
	foot: ReactNode;
	notice: string | null;
	artRef?: Ref<HTMLDivElement>;
	/** 送信の動きを待つ間は閉じるを効かなくする(離れても回答だけ送られるのを防ぐ) */
	closeDisabled?: boolean;
};

export function ProposalFrame({
	latch,
	now,
	pressed,
	text,
	foot,
	notice,
	artRef,
	closeDisabled = false,
}: FrameProps) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
		return () => clearInterval(t);
	}, []);
	// 親のnowは取得時点で止まるため・再描画ごとに実時計と比べて新しい方を使う
	void tick;
	const effectiveNow = new Date(Math.max(now.getTime(), Date.now()));
	const group = latch.participants_count > 2;
	return (
		<div
			className={`screen room proposal${pressed ? " is-pressed" : ""}`}
			data-theme="dark"
		>
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link
						className="icon-btn"
						to={PATHS.home}
						aria-label="あとで回答する"
						aria-disabled={closeDisabled ? "true" : undefined}
						tabIndex={closeDisabled ? -1 : undefined}
						onClick={(event) => {
							if (closeDisabled) event.preventDefault();
						}}
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body">
				<div className="proposal__stage">
					{group ? (
						<GroupDisc
							count={latch.participants_count}
							size={224}
							light={!pressed}
						/>
					) : (
						<LatchArt
							ref={artRef}
							state={pressed ? "pressed" : "arrived"}
							size={212}
							gap={22}
						/>
					)}
				</div>
				<div className="pad proposal__text">
					{text}
					<div className="deadline" style={{ marginTop: 26 }}>
						<span className="t-label">回答期限</span>
						<div className="deadline__row">
							<span className="deadline__when">
								{formatWhen(latch.response_deadline, effectiveNow)} まで
							</span>
							<span className="deadline__left">
								{formatLeft(latch.response_deadline, effectiveNow)}
							</span>
						</div>
					</div>
				</div>
			</div>
			<div className="screen__foot">
				{notice !== null ? (
					<p className="t-caption" role="alert">
						{notice}
					</p>
				) : null}
				{foot}
			</div>
		</div>
	);
}

type ProposalProps = {
	latch: LatchDTO;
	now: Date;
	busy: boolean;
	notice: string | null;
	onJoin(): void;
	onDefer(): void;
	artRef?: Ref<HTMLDivElement>;
};

export function Proposal({
	latch,
	now,
	busy,
	notice,
	onJoin,
	onDefer,
	artRef,
}: ProposalProps) {
	const group = latch.participants_count > 2;
	return (
		<ProposalFrame
			latch={latch}
			now={now}
			pressed={false}
			notice={notice}
			artRef={artRef}
			closeDisabled={busy}
			text={
				<>
					<p className="t-eyebrow">提案</p>
					<h1 className="t-display" style={{ marginTop: 12 }}>
						条件が合う候補が
						<br />
						あります。
					</h1>
					{group ? (
						<p className="group-need">
							<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
								<path className="gt" d="M10.9 1.5A8.5 8.5 0 0 1 10.9 18.5" />
								<path className="gm" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
							</svg>
							あなたを含む{latch.participants_count}人で成立します
						</p>
					) : null}
				</>
			}
			foot={
				<>
					<button
						className="btn btn--primary btn--block"
						type="button"
						onClick={onJoin}
						disabled={busy}
					>
						参加する
					</button>
					<button
						className="btn btn--secondary btn--block"
						type="button"
						onClick={onDefer}
						disabled={busy}
					>
						今回は見送る
					</button>
					<p className="t-caption" style={{ textAlign: "center" }}>
						{group ? "全員" : "お互い"}が参加すると、はじめて相手が見えます。
					</p>
				</>
			}
		/>
	);
}
