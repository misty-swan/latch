/**
 * つながりました画面(表示のみ・prototype/app/app.js screens.matched・summaryFacts・
 * Matched.dc.html・F4c設計)。メッセージ導線はチャット実装(F5)まで置かない。
 * freshのときだけ「押す→はまる→にじみが引く」の演出を行う。
 */

import type { LatchDTO } from "@latch/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
import { formatMatchedAt, formatWhen, formatYen } from "../../latches/format";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { Avatar, GroupDisc, LatchArt } from "./art";

/** 押してからはまるまで・にじみが引くまで(prototypeの650ms・1700ms) */
const PRESS_MS = 650;
const BLEED_MS = 1700;
const TONES = ["b", "c", "d", "e"] as const;

type MatchedProps = {
	latch: LatchDTO;
	now: Date;
	fresh: boolean;
};

/** 「重なったところ」の1行(prototype factRow・edit:false) */
function Fact({
	label,
	value,
	muted,
}: {
	label: string;
	value: string;
	muted?: boolean;
}) {
	return (
		<div className="fact">
			<dt className="fact__key">{label}</dt>
			<dd className={`fact__val${muted ? " fact__val--muted" : ""}`}>
				{value}
			</dd>
			<span />
		</div>
	);
}

export function Matched({ latch, now, fresh }: MatchedProps) {
	const artRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!fresh) return;
		const el = artRef.current;
		let t2: ReturnType<typeof setTimeout> | undefined;
		const t1 = setTimeout(() => {
			el?.classList.remove("is-pressed");
			el?.classList.add("is-latched", "is-bleeding");
			try {
				navigator.vibrate?.(14);
			} catch {
				// 振動できない端末では何もしない
			}
			t2 = setTimeout(() => el?.classList.remove("is-bleeding"), BLEED_MS);
		}, PRESS_MS);
		return () => {
			clearTimeout(t1);
			clearTimeout(t2);
		};
	}, [fresh]);

	const members = latch.members ?? [];
	const proposal = latch.proposal;
	const group = members.length > 1;
	const size = members.length + 1;
	const topic = proposal?.topic ?? "指定なし";
	const region = proposal?.region_name ?? null;

	let facts: ReactNode = null;
	if (proposal?.form === "occasion") {
		facts = (
			<>
				<Fact label="主題" value={topic} />
				<Fact
					label="日時"
					value={
						proposal.time_window
							? `${formatWhen(proposal.time_window.start, now)}〜`
							: "指定なし"
					}
				/>
				<Fact label="場所" value={region ?? "指定なし"} />
				<Fact label="人数" value={`${size}人`} />
				<Fact
					label="予算"
					value={
						proposal.budget
							? `${formatYen(proposal.budget.max)}以内`
							: "指定なし"
					}
				/>
			</>
		);
	} else if (proposal) {
		facts = (
			<>
				<Fact label="主題" value={topic} />
				<Fact label="預け方" value="つながり" />
				<Fact label="人数" value={`${size}人`} />
				<Fact
					label="地域"
					value={region ?? "指定なし(全国)"}
					muted={region === null}
				/>
			</>
		);
	}

	const first = members[0];
	const people = group ? (
		<div className="stack" style={{ gap: 14, marginTop: 22 }}>
			{members.map((m, i) => (
				<div className="row" style={{ gap: 14 }} key={m.user_id}>
					<Avatar
						userId={m.user_id}
						hasIcon={m.has_icon}
						size="m"
						tone={TONES[i % TONES.length]}
					/>
					<p className="t-head">{m.display_name}</p>
				</div>
			))}
		</div>
	) : first ? (
		<>
			<div className="partner">
				<Avatar
					userId={first.user_id}
					hasIcon={first.has_icon}
					size="l"
					tone="b"
					label={`${first.display_name}のアイコン`}
				/>
				<div>
					<p className="t-title">{first.display_name}</p>
					{latch.matched_at ? (
						<p className="t-meta">
							{formatMatchedAt(latch.matched_at)} につながりました
						</p>
					) : null}
				</div>
			</div>
			{first.bio !== null ? (
				<p className="t-words partner__bio">{first.bio}</p>
			) : null}
		</>
	) : null;

	return (
		<div className={`screen matched${fresh ? " is-fresh" : ""}`}>
			<ScreenGrain />
			<div className="dawn" aria-hidden="true" />
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
			<div className="screen__body" style={{ paddingBottom: 16 }}>
				<div className="matched__stage">
					{group ? (
						// 他メンバーの色(prototypeのAV)はlatch.cssに変数として無いため自分(墨)だけ塗る
						<GroupDisc count={size} size={200} />
					) : (
						<LatchArt
							ref={artRef}
							state={fresh ? "pressed" : "latched"}
							size={184}
							gap={20}
							ring
						/>
					)}
				</div>
				<div className="pad">
					<p className="t-eyebrow m-rise">つながった</p>
					<h1 className="t-display m-rise m-rise-1" style={{ marginTop: 10 }}>
						つながりました。
					</h1>
					<div className="m-rise m-rise-2">{people}</div>
					<h2 className="t-label m-rise m-rise-3" style={{ marginTop: 28 }}>
						重なったところ
					</h2>
					<dl className="facts m-rise m-rise-3" style={{ marginTop: 8 }}>
						{facts}
					</dl>
				</div>
			</div>
			<div className="screen__foot m-rise m-rise-4">
				<Link className="btn btn--quiet" to={PATHS.home}>
					あとで
				</Link>
			</div>
		</div>
	);
}
