/**
 * チャット画面(/latches/:id/chat・F6b設計 §1.3〜§1.4)。見出し・冒頭・履歴・終了の帯。
 * 入力欄(Task 6)・メニュー(Task 7)の場所は空けてある。
 * prototype/app/app.jsのchatHead・screens.chatの移植。
 */

import type { LatchDTO, MessageDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import {
	connectionName,
	connectionSubtitle,
	isEndedConnection,
} from "../../chat/format";
import {
	appendMessage,
	CONNECTIONS_QUERY_KEY,
	flattenMessages,
	newClientId,
	postMessage,
	refreshLatestMessages,
	requestWsTicket,
	useMarkRead,
	useMessagesQuery,
} from "../../chat/queries";
import { openChatSocket } from "../../chat/socket";
import { formatMatchedAt } from "../../latches/format";
import { latchQueryKey, useLatchQuery } from "../../latches/queries";
import { useMeQuery } from "../../me/queries";
import { isOfflineError, OFFLINE_MESSAGES } from "../../offline/errors";
import { latchPath, PATHS, reportPath } from "../../routes/paths";
import { Avatar, LatchArt } from "../latch/art";
import { LatchLoadFailed } from "../latch/LatchScreen";
import { ScreenGrain } from "../shared";
import "./chat.css";
import { ChatMenu } from "./ChatMenu";
import { Composer } from "./Composer";
import { MessageList, type PendingMessage } from "./MessageList";

const TONES = ["b", "c", "d", "e"] as const;
/** トーストを出しておく時間(Shelved.tsxと同じ) */
const TOAST_MS = 2400;
const isRedirectError = (error: unknown): boolean => {
	if (!(error instanceof ApiError)) return false;
	if (error.code === "NOT_FOUND") return true;
	const reasons = error.details.reasons;
	return Array.isArray(reasons) && reasons.includes("invalid_status");
};

/** 送信が「もう書けない状態」で断られたか(失敗表示ではなくLATCHの取り直しへ) */
const isNotWritable = (error: unknown): boolean => {
	if (!(error instanceof ApiError)) return false;
	if (error.code === "NOT_FOUND") return true;
	const reasons = error.details.reasons;
	return (
		Array.isArray(reasons) &&
		(reasons.includes("read_only") || reasons.includes("invalid_status"))
	);
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

function ChatTopbar({
	latch,
	onMenu,
}: {
	latch: LatchDTO | null;
	onMenu?: () => void;
}) {
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
					<button
						type="button"
						className="icon-btn"
						aria-label="このつながりについて"
						onClick={onMenu}
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
	const client = useQueryClient();
	const markRead = useMarkRead(latch.id);
	const [pending, setPending] = useState<PendingMessage[]>([]);
	const pendingRef = useRef(pending);
	pendingRef.current = pending;
	const matched = latch.status === "matched";
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	/** 操作を開いた相手の発言(F7c設計 §1.2) */
	const [menuMessage, setMenuMessage] = useState<MessageDTO | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	useEffect(() => {
		if (toast === null) return;
		const t = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(t);
	}, [toast]);

	const onLeft = (result: LatchDTO) => {
		const message = "参加を取り消しました。";
		if (result.status === "cancelled") {
			// 全体が終わった: その場に留まり読み取り専用の表示へ
			setMenuOpen(false);
			setToast(message);
		} else {
			// 本人だけが抜けた(以後は読めない): 一覧へ戻りトーストは遷移先で出す
			navigate(PATHS.connections, { replace: true, state: { toast: message } });
		}
	};
	// ブロック(F7c設計 §1.8)。1対1は全体が終わりその場で読み取り専用になる(useBlockがLATCHを取り直す)。
	// 続いているグループは本人が抜けて以後このLATCHを読めない(404)ため・一覧へ置き換えで移る
	const onBlocked = (left: boolean) => {
		const message = "ブロックしました。";
		if (left) {
			navigate(PATHS.connections, { replace: true, state: { toast: message } });
		} else {
			setMenuOpen(false);
			setToast(message);
		}
	};
	const reportMessage = (m: MessageDTO) =>
		navigate(reportPath(latch.id, { messageId: m.id, userId: m.user_id }), {
			state: { quote: m.body },
		});

	// 消したチャットへ「戻る」で戻らないよう置き換えで移る
	const onHidden = () =>
		navigate(PATHS.connections, {
			replace: true,
			state: { toast: "一覧から消しました。" },
		});

	const scrollRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const firstScrolled = useRef(false);
	const heightBefore = useRef<number | null>(null);

	const flat = data ? flattenMessages(data.pages) : [];
	const loaded = data !== undefined;
	const latestId = flat[flat.length - 1]?.id ?? null;
	// 確定済みのclient_idと一致する未確定の吹き出しは描かない(WebSocketが応答より先に届く場合)
	const confirmedClientIds = new Set(
		flat.flatMap((m) => (m.client_id ? [m.client_id] : [])),
	);
	const shownPending = pending.filter(
		(p) => !confirmedClientIds.has(p.clientId),
	);

	const setState = (clientId: string, state: PendingMessage["state"]) =>
		setPending((list) =>
			list.map((p) => (p.clientId === clientId ? { ...p, state } : p)),
		);
	const dropPending = (clientId: string) =>
		setPending((list) => list.filter((p) => p.clientId !== clientId));

	const deliver = (clientId: string, body: string) => {
		postMessage(latch.id, body, clientId).then(
			(message) => {
				appendMessage(client, latch.id, message);
				dropPending(clientId);
				// 一覧の最終メッセージ・LATCHの表示を取り直す(F6b設計 §2.5)
				void client.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
				void client.invalidateQueries({ queryKey: latchQueryKey(latch.id) });
			},
			(error: unknown) => {
				if (isNotWritable(error)) {
					dropPending(clientId);
					void client.invalidateQueries({ queryKey: latchQueryKey(latch.id) });
				} else {
					setState(clientId, "failed");
					if (isOfflineError(error)) setToast(OFFLINE_MESSAGES.send);
				}
			},
		);
	};

	const send = (body: string) => {
		const clientId = newClientId();
		forceScroll.current = true;
		setPending((list) => [...list, { clientId, body, state: "sending" }]);
		deliver(clientId, body);
	};

	const retry = (clientId: string) => {
		const target = pendingRef.current.find((p) => p.clientId === clientId);
		if (!target) return;
		setState(clientId, "sending");
		deliver(clientId, target.body);
	};

	// 受信: 続いている間だけWebSocketをつなぐ(画面を離れる・matchedでなくなると閉じる)
	const latchId = latch.id;
	useEffect(() => {
		if (!matched) return;
		const socket = openChatSocket(
			latchId,
			(e) => {
				if (e.type === "message") appendMessage(client, latchId, e.message);
				else if (e.type === "open") {
					void refreshLatestMessages(client, latchId).catch(() => {});
				} else {
					void client.invalidateQueries({ queryKey: latchQueryKey(latchId) });
				}
			},
			{
				fetchTicket: requestWsTicket,
				createSocket: (url) => new WebSocket(url),
				setTimeout,
				clearTimeout,
				setInterval,
				clearInterval,
			},
		);
		return () => socket.close();
	}, [matched, latchId, client]);

	// 画面に戻ったとき取りこぼしを埋める
	useEffect(() => {
		const onFocus = () => {
			void refreshLatestMessages(client, latchId).catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [client, latchId]);

	// 既読: 表示中の最新の確定メッセージ(終了後も)。画面が見えている間だけ送り・
	// 隠れていた間に届いた分は見える状態へ戻ったときに送る(F6b設計 §2.2・§2.4)
	useEffect(() => {
		const mark = () => {
			if (latestId && document.visibilityState === "visible") {
				markRead(latestId);
			}
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [latestId, markRead]);

	// 自分の送信では必ず最下部へ・他の変化は末尾近く(80px以内)を見ていたときだけ追う
	const nearBottom = useRef(true);
	const forceScroll = useRef(false);
	const scrollKey = `${latestId}:${shownPending.length}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 末尾の変化で走らせる
	useEffect(() => {
		const el = scrollRef.current;
		if (
			el &&
			firstScrolled.current &&
			(forceScroll.current || nearBottom.current)
		) {
			el.scrollTop = el.scrollHeight;
		}
		forceScroll.current = false;
	}, [scrollKey]);

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
			<ChatTopbar latch={latch} onMenu={() => setMenuOpen(true)} />
			<div
				className="screen__body"
				ref={scrollRef}
				onScroll={(e) => {
					const el = e.currentTarget;
					nearBottom.current =
						el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
				}}
			>
				{/* 届いたメッセージを支援技術へ控えめに知らせる */}
				<div className="chat" role="log">
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
					{/* 冒頭は最も古い頁まで読み込んでから出す(古い履歴の上に出さない) */}
					{loaded && !hasNextPage ? (
						<Origin latch={latch} matchedAt={matchedAt} />
					) : null}
					{messages.isError && !loaded ? (
						<div style={{ alignSelf: "center", textAlign: "center" }}>
							<p className="t-caption">履歴を読み込めませんでした。</p>
							<button
								type="button"
								className="btn btn--secondary"
								style={{ marginTop: 12 }}
								onClick={() => void messages.refetch()}
							>
								もう一度読み込む
							</button>
						</div>
					) : null}
					{loaded ? (
						<MessageList
							latch={latch}
							meId={me.data?.id ?? ""}
							messages={flat}
							now={now}
							pending={shownPending}
							onRetry={retry}
							onMessageMenu={setMenuMessage}
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
			) : (
				<Composer onSend={send} />
			)}
			{toast !== null ? (
				<p className="toast" role="status">
					{toast}
				</p>
			) : null}
			{menuOpen ? (
				<ChatMenu
					latch={latch}
					onClose={() => setMenuOpen(false)}
					onLeft={onLeft}
					onHidden={onHidden}
					onBlocked={onBlocked}
				/>
			) : null}
			{menuMessage !== null ? (
				<>
					<div
						className="backdrop"
						aria-hidden="true"
						onClick={() => setMenuMessage(null)}
					/>
					<div
						className="sheet-layer"
						role="dialog"
						aria-modal="true"
						aria-label="このメッセージについて"
					>
						<div className="sheet">
							<span className="sheet__grab" aria-hidden="true" />
							<h2 className="sheet__title" style={{ fontSize: 19 }}>
								このメッセージについて
							</h2>
							<div
								className="list"
								style={{ margin: "0 calc(var(--gutter) * -1)" }}
							>
								<button
									type="button"
									className="list-row"
									onClick={() => reportMessage(menuMessage)}
								>
									<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
										<path d="M6 20.5V4.5M6 5h11.2l-2.2 4 2.2 4H6" />
									</svg>
									<span>このメッセージを通報する</span>
									<svg
										className="ic list-row__chev"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<path d="M9.5 6l6 6-6 6" />
									</svg>
								</button>
							</div>
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--quiet btn--block"
									onClick={() => setMenuMessage(null)}
								>
									閉じる
								</button>
							</div>
						</div>
					</div>
				</>
			) : null}
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
