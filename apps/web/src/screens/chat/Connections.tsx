/**
 * つながり一覧(/connections・F6b設計 §1.2)。prototype/app/app.jsの
 * screens.connections・ConnectionsEmpty.dc.htmlの移植。上部の5段階の問いは
 * つながりの品質の自己申告(docs/01 §14・docs/05 §3.3・F9)で、feedback_dueが
 * connection_qualityの先頭の1件だけをたずねる(Connections.dc.html)。
 */

import type { LatchDTO } from "@latch/shared";
import { useIsRestoring } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router";
import {
	connectionName,
	connectionSubtitle,
	ENDED_PARTNER_NAME,
	formatAgo,
	isEndedConnection,
} from "../../chat/format";
import { useConnectionsQuery } from "../../chat/queries";
import { useFeedbackMutation } from "../../latches/queries";
import { isOfflineError } from "../../offline/errors";
import { OfflineBanner } from "../../offline/OfflineBanner";
import { useOnline } from "../../offline/online";
import { chatPath, PATHS } from "../../routes/paths";
import { Avatar, LatchArt } from "../latch/art";
import { RouteToast, useRouteToast } from "../RouteToast";
import { ScreenGrain } from "../shared";
import { TabBar } from "../TabBar";
import { TopbarActions } from "../TopbarActions";

const TONES = ["b", "c", "d", "e"] as const;

/** トーストを出しておく時間(RouteToastと同じ) */
const TOAST_MS = 2400;

/** トップバー。brandは預けている一覧へ・自分は表示のみ(Homeと同じ扱い) */
function ConnectionsTopbar() {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<Link
					className="brand"
					to={PATHS.home}
					aria-label="LATCH 預けている一覧へ"
				>
					<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
						<path className="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z" />
						<path
							className="mark__theirs"
							d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z"
						/>
					</svg>
					<span className="brand__word">LATCH</span>
				</Link>
			</div>
			<span />
			<div className="topbar__side topbar__side--end">
				<TopbarActions />
			</div>
		</header>
	);
}

function RowIcon({ latch }: { latch: LatchDTO }) {
	if (latch.status === "cancelled") {
		return <span className="avatar avatar--gone" aria-hidden="true" />;
	}
	const members = latch.members ?? [];
	if (members.length > 1) {
		return (
			<span className="avatars avatars--stack">
				{members.slice(0, 2).map((m, i) => (
					<Avatar
						key={m.user_id}
						userId={m.user_id}
						hasIcon={m.has_icon}
						size="m"
						tone={TONES[i % TONES.length]}
					/>
				))}
			</span>
		);
	}
	const m = members[0];
	return (
		<Avatar
			userId={m?.user_id}
			hasIcon={m?.has_icon ?? false}
			size="m"
			tone="b"
		/>
	);
}

/** 問いの見出しの相手。実名を出さない終了の相手には「さん」を付けない */
const surveyPartner = (latch: LatchDTO): string => {
	const name = connectionName(latch);
	return name === ENDED_PARTNER_NAME ? name : `${name}さん`;
};

/** つながりの品質の5段階の問い(Connections.dc.html)。選ぶか[スキップ]で1回だけ答える */
function ConnectionSurvey({
	latch,
	disabled,
	onAnswer,
}: {
	latch: LatchDTO;
	disabled: boolean;
	onAnswer: (score: number | null) => void;
}) {
	return (
		<form className="survey rise rise-1" style={{ marginTop: 12 }}>
			<p className="t-head">
				{surveyPartner(latch)}とのつながりは、どうでしたか。
			</p>
			<div className="scale" role="radiogroup" aria-label="5段階">
				{[1, 2, 3, 4, 5].map((n) => (
					<label key={n}>
						<input
							type="radio"
							name="sv2"
							value={n}
							disabled={disabled}
							onChange={() => onAnswer(n)}
						/>
						<span>{n}</span>
					</label>
				))}
			</div>
			<div className="row" style={{ justifyContent: "space-between" }}>
				<span className="t-meta">1 いまひとつ</span>
				<span className="t-meta">5 とてもよい</span>
			</div>
			<div className="row" style={{ justifyContent: "flex-end" }}>
				<button
					className="btn btn--quiet btn--small"
					type="button"
					disabled={disabled}
					onClick={() => onAnswer(null)}
				>
					スキップ
				</button>
			</div>
		</form>
	);
}

function Row({ latch, now }: { latch: LatchDTO; now: Date }) {
	const ended = isEndedConnection(latch);
	const last = latch.last_message ?? null;
	const agoIso = last?.created_at ?? latch.matched_at;
	const unread = latch.unread_count ?? 0;
	return (
		<li>
			<Link
				className={`conn${ended ? " is-ended" : ""}`}
				to={chatPath(latch.id)}
			>
				<RowIcon latch={latch} />
				<span className="stack" style={{ minWidth: 0 }}>
					<span className="row" style={{ gap: 8, minWidth: 0 }}>
						<span className="conn__name clamp-1">{connectionName(latch)}</span>
					</span>
					<span className="conn__topic">
						{connectionSubtitle(latch).map((part, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 副題は静的な短い並び
							<Fragment key={i}>
								{i > 0 ? <span className="sep">·</span> : null}
								{part}
							</Fragment>
						))}
					</span>
					<span className="conn__last clamp-1">
						{last ? last.body : "最初のひとことを送ってみましょう"}
					</span>
				</span>
				<span className="conn__side">
					<span className="t-meta">{agoIso ? formatAgo(agoIso, now) : ""}</span>
					{unread > 0 ? (
						<span className="unread" role="img" aria-label={`未読${unread}件`}>
							{unread}
						</span>
					) : null}
				</span>
			</Link>
		</li>
	);
}

export function Connections() {
	const toast = useRouteToast();
	const {
		data,
		isPending,
		isError,
		isRefetchError,
		error,
		refetch,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useConnectionsQuery();
	const online = useOnline();
	// 端末の保存を読み戻している間は、オフラインでも読み込めなかった表示にしない
	const restoring = useIsRestoring();
	const offline = !online || (isRefetchError && isOfflineError(error));
	const now = new Date();
	const feedback = useFeedbackMutation();
	// 送った問いは応答を待たずに隠し(一覧の取り直しまでの間に再び出さない)、失敗したら戻す
	const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
	const [thanks, setThanks] = useState(false);
	useEffect(() => {
		if (!thanks) return;
		const t = setTimeout(() => setThanks(false), TOAST_MS);
		return () => clearTimeout(t);
	}, [thanks]);

	if (isPending || data === undefined) {
		return (
			<div className="screen connections">
				<ScreenGrain />
				<ConnectionsTopbar />
				<div className="screen__body pad" style={{ paddingTop: 6 }}>
					<h1 className="t-display">つながり</h1>
					{isError || (!online && !restoring) ? (
						<>
							{!online && <OfflineBanner />}
							<p className="t-caption" style={{ marginTop: 8 }}>
								一覧を読み込めませんでした。
							</p>
							<button
								type="button"
								className="btn btn--secondary"
								style={{ marginTop: 16 }}
								onClick={() => void refetch()}
							>
								もう一度読み込む
							</button>
						</>
					) : null}
				</div>
				<TabBar current="connections" />
				<RouteToast text={toast} />
			</div>
		);
	}

	const items = data.pages.flatMap((p) => p.items);

	if (items.length === 0) {
		return (
			<div className="screen connections connections--empty">
				<ScreenGrain />
				<ConnectionsTopbar />
				<div
					className="screen__body pad"
					style={{
						display: "flex",
						flexDirection: "column",
						paddingBottom: 140,
					}}
				>
					<div style={{ paddingTop: 6 }}>
						<h1 className="t-display">つながり</h1>
					</div>
					<div style={{ flex: 1 }} />
					<div style={{ alignSelf: "center" }} className="rise">
						<LatchArt state="ended" size={168} gap={0} />
					</div>
					<div style={{ flex: 1 }} />
					<h2 className="t-display t-display--s rise rise-1">
						まだ、つながりはありません。
					</h2>
					<p className="t-body rise rise-2" style={{ marginTop: 10 }}>
						提案にお互いが参加すると、ここに並びます。それまでは、預けて待つだけです。
					</p>
				</div>
				<TabBar current="connections" />
				<RouteToast text={toast} />
			</div>
		);
	}

	const active = items.filter((l) => l.status === "matched");
	const done = items.filter(isEndedConnection);
	const survey = items.find(
		(l) => l.feedback_due === "connection_quality" && !answered.has(l.id),
	);
	const answerSurvey = (id: string, score: number | null) => {
		setAnswered((prev) => new Set(prev).add(id));
		feedback.mutate(
			{ id, body: { kind: "connection_quality", value: { score } } },
			{
				onSuccess: () => {
					if (score !== null) setThanks(true);
				},
				onError: () =>
					setAnswered((prev) => {
						const next = new Set(prev);
						next.delete(id);
						return next;
					}),
			},
		);
	};

	return (
		<div className="screen connections">
			<ScreenGrain />
			<ConnectionsTopbar />
			<div className="screen__body" style={{ paddingBottom: 132 }}>
				<div className="pad" style={{ paddingTop: 6, paddingBottom: 6 }}>
					<h1 className="t-display rise">つながり</h1>
					<p className="t-caption rise rise-1">
						お互いが参加して、つながった相手です。
					</p>
				</div>
				{offline && (
					<div className="pad">
						<OfflineBanner />
					</div>
				)}
				{survey ? (
					<ConnectionSurvey
						key={survey.id}
						latch={survey}
						disabled={feedback.isPending}
						onAnswer={(score) => answerSurvey(survey.id, score)}
					/>
				) : null}
				{active.length > 0 ? (
					<>
						<h2 className="list__head t-label">つながっている</h2>
						<ul>
							{active.map((l) => (
								<Row key={l.id} latch={l} now={now} />
							))}
						</ul>
					</>
				) : null}
				{done.length > 0 ? (
					<>
						<h2 className="list__head t-label">終了</h2>
						<ul>
							{done.map((l) => (
								<Row key={l.id} latch={l} now={now} />
							))}
						</ul>
					</>
				) : null}
				{hasNextPage ? (
					<div className="pad" style={{ paddingTop: 16 }}>
						<button
							type="button"
							className="btn btn--secondary"
							disabled={isFetchingNextPage}
							onClick={() => void fetchNextPage()}
						>
							さらに表示
						</button>
					</div>
				) : null}
			</div>
			<TabBar current="connections" />
			<RouteToast text={thanks ? "ありがとうございます。" : toast} />
		</div>
	);
}
