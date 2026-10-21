/**
 * つながり一覧(/connections・F6b設計 §1.2)。prototype/app/app.jsの
 * screens.connections・ConnectionsEmpty.dc.htmlの移植。アンケート・アプリ内通知は後続フェーズ。
 */

import type { LatchDTO } from "@latch/shared";
import { Fragment, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
	connectionName,
	connectionSubtitle,
	formatAgo,
	isEndedConnection,
} from "../../chat/format";
import { useConnectionsQuery } from "../../chat/queries";
import { chatPath, PATHS } from "../../routes/paths";
import { Avatar, LatchArt } from "../latch/art";
import { ScreenGrain } from "../shared";
import { TabBar } from "../TabBar";

const TONES = ["b", "c", "d", "e"] as const;
/** トーストを出しておく時間(Shelved.tsxと同じ) */
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
				<span className="icon-btn" role="img" aria-label="自分">
					<span className="avatar avatar--a avatar--s" aria-hidden="true" />
				</span>
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

/** 遷移元が渡したトースト(location.state.toast)を一度だけ出す。再読み込み・戻るで再表示しない */
function useRouteToast(): string | null {
	const location = useLocation();
	const navigate = useNavigate();
	const incoming = (location.state as { toast?: unknown } | null)?.toast;
	const [toast, setToast] = useState<string | null>(
		typeof incoming === "string" ? incoming : null,
	);
	useEffect(() => {
		if (typeof incoming !== "string") return;
		setToast(incoming);
		navigate(location.pathname, { replace: true, state: null });
	}, [incoming, location.pathname, navigate]);
	useEffect(() => {
		if (toast === null) return;
		const t = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(t);
	}, [toast]);
	return toast;
}

function RouteToast({ text }: { text: string | null }) {
	return text === null ? null : (
		<p className="toast" role="status">
			{text}
		</p>
	);
}

export function Connections() {
	const toast = useRouteToast();
	const {
		data,
		isPending,
		isError,
		refetch,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useConnectionsQuery();
	const now = new Date();

	if (isPending || isError || data === undefined) {
		return (
			<div className="screen connections">
				<ScreenGrain />
				<ConnectionsTopbar />
				<div className="screen__body pad" style={{ paddingTop: 6 }}>
					<h1 className="t-display">つながり</h1>
					{isError ? (
						<>
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
			<RouteToast text={toast} />
		</div>
	);
}
