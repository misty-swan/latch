/**
 * チャット画面(/latches/:id/chat・F6b設計 §1.3〜§1.4)。見出し・冒頭・履歴・終了の帯。
 * 入力欄(Task 6)・メニュー(Task 7)の場所は空けてある。
 * prototype/app/app.jsのchatHead・screens.chatの移植。
 */

import type { LatchDTO } from "@latch/shared";
import { Fragment, useLayoutEffect, useRef } from "react";
import { Link, Navigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import {
	connectionName,
	connectionSubtitle,
	isEndedConnection,
} from "../../chat/format";
import {
	flattenMessages,
	useMeQuery,
	useMessagesQuery,
} from "../../chat/queries";
import { formatMatchedAt } from "../../latches/format";
import { useLatchQuery } from "../../latches/queries";
import { latchPath, PATHS } from "../../routes/paths";
import { Avatar, LatchArt } from "../latch/art";
import { LatchLoadFailed } from "../latch/LatchScreen";
import { ScreenGrain } from "../shared";
import { MessageList, type PendingMessage } from "./MessageList";

const TONES = ["b", "c", "d", "e"] as const;
/** Task 6が送信中・失敗の吹き出しを渡すまでは空 */
const NO_PENDING: PendingMessage[] = [];

const isRedirectError = (error: unknown): boolean => {
	if (!(error instanceof ApiError)) return false;
	if (error.code === "NOT_FOUND") return true;
	const reasons = error.details.reasons;
	return Array.isArray(reasons) && reasons.includes("invalid_status");
};

function HeadIcon({ latch }: { latch: LatchDTO }) {
	if (latch.status === "cancelled") {
		return (
			<span className="avatar avatar--s avatar--gone" aria-hidden="true" />
		);
	}
	const members = latch.members ?? [];
	if (members.length > 1) {
		return (
			<span className="avatars">
				{members.map((m, i) => (
					<Avatar
						key={m.user_id}
						userId={m.user_id}
						hasIcon={m.has_icon}
						size="s"
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
			size="s"
			tone="b"
		/>
	);
}

function ChatHead({ latch }: { latch: LatchDTO }) {
	return (
		<div className="chat-head">
			<HeadIcon latch={latch} />
			<div className="stack" style={{ minWidth: 0 }}>
				<p className="chat-head__name">{connectionName(latch)}</p>
				<p className="chat-head__sub">
					{connectionSubtitle(latch).map((part, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 副題は静的な短い並び
						<Fragment key={i}>
							{i > 0 ? <span className="sep">·</span> : null}
							{part}
						</Fragment>
					))}
				</p>
			</div>
		</div>
	);
}

function ChatTopbar({ latch }: { latch: LatchDTO | null }) {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<Link className="icon-btn" to={PATHS.connections} aria-label="戻る">
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M14.5 5.5L8 12l6.5 6.5" />
					</svg>
				</Link>
			</div>
			<div className="topbar__title">
				{latch ? <ChatHead latch={latch} /> : null}
			</div>
			<div className="topbar__side topbar__side--end">
				{latch ? (
					// 中身(メニューシート)はTask 7で結ぶ
					<button
						type="button"
						className="icon-btn"
						aria-label="このつながりについて"
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<circle
								cx="5.5"
								cy="12"
								r="1.25"
								fill="currentColor"
								stroke="none"
							/>
							<circle
								cx="12"
								cy="12"
								r="1.25"
								fill="currentColor"
								stroke="none"
							/>
							<circle
								cx="18.5"
								cy="12"
								r="1.25"
								fill="currentColor"
								stroke="none"
							/>
						</svg>
					</button>
				) : null}
			</div>
		</header>
	);
}

/** 冒頭「M月D日 H:MM につながりました」「主題·N人(·場所)」 */
function Origin({ latch, matchedAt }: { latch: LatchDTO; matchedAt: string }) {
	const ended = isEndedConnection(latch);
	const topic = latch.proposal?.topic ?? null;
	const place =
		latch.form === "occasion" ? (latch.proposal?.region_name ?? null) : null;
	const parts = [
		...(topic ? [topic] : []),
		`${latch.participants_count}人`,
		...(place ? [place] : []),
	];
	return (
		<div className="chat__origin">
			<LatchArt state={ended ? "ended" : "latched"} size={30} gap={0} />
			<p className="t-meta">{formatMatchedAt(matchedAt)} につながりました</p>
			<p className="t-caption">
				{parts.map((part, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 静的な短い並び
					<Fragment key={i}>
						{i > 0 ? <span className="sep">·</span> : null}
						{part}
					</Fragment>
				))}
			</p>
		</div>
	);
}

const hasIntersectionObserver = (): boolean =>
	typeof IntersectionObserver !== "undefined";

function ChatView({
	latch,
	matchedAt,
}: {
	latch: LatchDTO;
	matchedAt: string;
}) {
	const me = useMeQuery();
	const messages = useMessagesQuery(latch.id);
	const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = messages;
	const ended = isEndedConnection(latch);
	const now = new Date();

	const scrollRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const firstScrolled = useRef(false);
	const heightBefore = useRef<number | null>(null);

	const flat = data ? flattenMessages(data.pages) : [];
	const loaded = data !== undefined;

	// 初回表示は最下部・古い頁を足した直後は見ていた位置を保つ(scrollHeightの差を足す)
	// biome-ignore lint/correctness/useExhaustiveDependencies: 件数の変化で走らせる
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !loaded) return;
		if (!firstScrolled.current) {
			firstScrolled.current = true;
			el.scrollTop = el.scrollHeight;
			return;
		}
		if (heightBefore.current !== null) {
			el.scrollTop += el.scrollHeight - heightBefore.current;
			heightBefore.current = null;
		}
	}, [loaded, flat.length]);

	const loadOlder = () => {
		if (!hasNextPage || isFetchingNextPage) return;
		heightBefore.current = scrollRef.current?.scrollHeight ?? null;
		void fetchNextPage();
	};
	const loadOlderRef = useRef(loadOlder);
	loadOlderRef.current = loadOlder;

	// 上端の番兵が見えたら古い頁を読む(IntersectionObserverが無い環境ではボタン)
	useLayoutEffect(() => {
		const target = sentinelRef.current;
		if (!target || !loaded || !hasIntersectionObserver()) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) loadOlderRef.current();
			},
			{ root: scrollRef.current },
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [loaded]);

	if (messages.isError && isRedirectError(messages.error)) {
		return <Navigate to={latchPath(latch.id)} replace />;
	}

	return (
		<div className="screen chat-screen">
			<ScreenGrain />
			<ChatTopbar latch={latch} />
			<div className="screen__body" ref={scrollRef}>
				<div className="chat">
					<div ref={sentinelRef} />
					{hasNextPage && !hasIntersectionObserver() ? (
						<button
							type="button"
							className="btn btn--quiet btn--small"
							style={{ alignSelf: "center" }}
							disabled={isFetchingNextPage}
							onClick={loadOlder}
						>
							古いメッセージを読み込む
						</button>
					) : null}
					<Origin latch={latch} matchedAt={matchedAt} />
					{loaded ? (
						<MessageList
							latch={latch}
							meId={me.data?.id ?? ""}
							messages={flat}
							now={now}
							pending={NO_PENDING}
							onRetry={() => {}}
						/>
					) : null}
				</div>
			</div>
			{ended ? (
				<div className="ended-bar">
					<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
						<circle className="go" cx="10" cy="10" r="7.6" />
						<path className="go" d="M10 2.4V17.6" />
					</svg>
					このつながりは終了しました
				</div>
			) : null}
			{/* 入力欄(.composer)はTask 6でここに置く */}
		</div>
	);
}

export function Chat() {
	const { id = "" } = useParams();
	const query = useLatchQuery(id);

	if (query.error instanceof ApiError && query.error.code === "NOT_FOUND") {
		return <Navigate to={latchPath(id)} replace />;
	}
	if (query.isError) {
		return <LatchLoadFailed onRetry={() => void query.refetch()} />;
	}
	const latch = query.data;
	if (!latch) {
		return (
			<div className="screen chat-screen">
				<ScreenGrain />
				<ChatTopbar latch={null} />
				<div className="screen__body" />
			</div>
		);
	}
	// 成立前・成立せず閉じたLATCHはF4cの状態の切り替えに任せる
	if (latch.matched_at === null) {
		return <Navigate to={latchPath(id)} replace />;
	}
	return <ChatView latch={latch} matchedAt={latch.matched_at} />;
}
