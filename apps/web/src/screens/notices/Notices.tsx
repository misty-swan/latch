/**
 * お知らせ一覧(/notices・F7c設計)。prototype/app/app.jsのscreens.notices・
 * Notices.dc.html・NoticesEmpty.dc.htmlの移植。表示した先頭のidまでを既読にする。
 */

import type { NotificationDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { formatAgo } from "../../chat/format";
import {
	clearComposeState,
	savePendingCompose,
} from "../../intents/composeState";
import { formatWhen } from "../../latches/format";
import { isLiveProposal, noticeText } from "../../notices/format";
import {
	markNoticesRead,
	UNREAD_QUERY_KEY,
	useNoticesQuery,
} from "../../notices/queries";
import { chatPath, latchPath, PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";

type GlyphKind = "proposed" | "closed" | "matched" | "expired";

/** prototypeのglyph(kind)と同じ半円の記号 */
function Glyph({ kind }: { kind: GlyphKind }) {
	return (
		<svg
			className="glyph"
			viewBox="0 0 20 20"
			aria-hidden="true"
			focusable="false"
		>
			{kind === "proposed" ? (
				<>
					<path className="gl" d="M11.3 1.5A8.5 8.5 0 0 1 11.3 18.5Z" />
					<path className="gm" d="M8.7 1.5A8.5 8.5 0 0 0 8.7 18.5Z" />
				</>
			) : kind === "matched" ? (
				<>
					<path className="gm" d="M10 1.5A8.5 8.5 0 0 0 10 18.5Z" />
					<path className="gf" d="M10 1.5A8.5 8.5 0 0 1 10 18.5Z" />
				</>
			) : kind === "expired" ? (
				<path className="go" d="M9.4 2.4A7.6 7.6 0 0 0 9.4 17.6Z" />
			) : (
				<path className="gp" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
			)}
		</svg>
	);
}

function NoticesTopbar() {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<Link className="icon-btn" to={PATHS.home} aria-label="戻る">
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M14.5 5.5L8 12l6.5 6.5" />
					</svg>
				</Link>
			</div>
			<div className="topbar__title">お知らせ</div>
			<div className="topbar__side topbar__side--end" />
		</header>
	);
}

function Row({ n, now }: { n: NotificationDTO; now: Date }) {
	const navigate = useNavigate();
	const cls = `notice${n.read_at ? "" : " is-unread"}`;
	const ago = formatAgo(n.created_at, now);
	const text = <span className="notice__text">{noticeText(n)}</span>;

	const link = (to: string, kind: GlyphKind, sub: ReactNode) => (
		<li>
			<Link className={cls} to={to}>
				<Glyph kind={kind} />
				<span>
					{text}
					<span className="notice__sub t-meta">{sub}</span>
				</span>
			</Link>
		</li>
	);

	switch (n.type) {
		case "proposal": {
			const live = isLiveProposal(n, now);
			return link(
				latchPath(n.latch_id),
				live ? "proposed" : "closed",
				<>
					{live ? (
						<>
							回答期限 {formatWhen(n.response_deadline, now)} まで
							<span className="sep">·</span>
						</>
					) : null}
					{ago}
				</>,
			);
		}
		case "matched":
			return link(chatPath(n.latch_id), "matched", ago);
		case "closed":
			return (
				<li>
					<div className={cls}>
						<Glyph kind="closed" />
						<span>
							{text}
							<span className="notice__sub t-meta">{ago}</span>
						</span>
					</div>
				</li>
			);
		case "intent_expired":
			return (
				<li>
					<div className={cls}>
						<Glyph kind="expired" />
						<span>
							{text}
							<span className="notice__quote clamp-1">{n.intent.raw_text}</span>
							<span className="notice__sub">
								<span className="t-meta">{ago}</span>
								<button
									className="btn btn--secondary btn--small"
									type="button"
									style={{ minHeight: 44, padding: "0 16px", fontSize: 13 }}
									onClick={() => {
										clearComposeState();
										savePendingCompose({
											raw_text: n.intent.raw_text,
											draft_id: null,
										});
										navigate(PATHS.compose);
									}}
								>
									もう一度預ける
								</button>
							</span>
						</span>
					</div>
				</li>
			);
	}
}

export function Notices() {
	const queryClient = useQueryClient();
	const {
		data,
		isPending,
		isError,
		refetch,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNoticesQuery();
	const now = new Date();
	const items = data?.pages.flatMap((p) => p.items) ?? [];
	const topId = data?.pages[0]?.items[0]?.id ?? null;

	// 表示した先頭のidまでを既読にする。同じ先頭idでは再送しない
	const sentRef = useRef<string | null>(null);
	useEffect(() => {
		if (topId === null || sentRef.current === topId) return;
		sentRef.current = topId;
		markNoticesRead(topId)
			.then(() =>
				queryClient.invalidateQueries({
					queryKey: UNREAD_QUERY_KEY,
					exact: true,
				}),
			)
			.catch(() => {
				// 既読にできなくても一覧は読める。次に開いたときにやり直す
			});
	}, [topId, queryClient]);

	return (
		<div className="screen notices">
			<ScreenGrain />
			<NoticesTopbar />
			<div className="screen__body" style={{ paddingBottom: 24 }}>
				{isPending || isError ? (
					isError ? (
						<div className="pad" style={{ paddingTop: 24 }}>
							<p className="t-caption">お知らせを読み込めませんでした。</p>
							<button
								type="button"
								className="btn btn--secondary"
								style={{ marginTop: 16 }}
								onClick={() => void refetch()}
							>
								もう一度読み込む
							</button>
						</div>
					) : null
				) : items.length === 0 ? (
					<div
						className="pad"
						style={{
							paddingTop: 150,
							display: "flex",
							flexDirection: "column",
							alignItems: "flex-start",
						}}
					>
						<div
							className="latch is-waiting"
							style={
								{
									"--size": "96px",
									"--gap": "8px",
									"--depth": ".6",
								} as CSSProperties
							}
							aria-hidden="true"
						>
							<span className="latch__light" />
							<span className="latch__mine" />
							<span className="latch__theirs">
								<span className="latch__ink" />
							</span>
						</div>
						<h1 className="t-display t-display--s" style={{ marginTop: 36 }}>
							お知らせは、まだありません。
						</h1>
						<p className="t-body" style={{ marginTop: 10 }}>
							提案が届いたときや、期限が来たときに、ここでお伝えします。
						</p>
					</div>
				) : (
					<>
						<ul className="rise">
							{items.map((n) => (
								<Row key={n.id} n={n} now={now} />
							))}
						</ul>
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
					</>
				)}
			</div>
		</div>
	);
}
