/**
 * 意思の詳細(/intents/:id・F8a設計 §1.3)。prototype/app/app.js screens.intentと
 * IntentDetail・IntentOccasion・IntentExpired.dc.htmlの移植。
 * - 状態で操作が変わる: active=一時停止・内容を直す・取り下げる・通知スイッチ/paused=再開(スイッチは動かせない)/
 *   expired=もう一度預ける・一覧から消す/それ以外(matched・cancelled・completed)は操作なし
 * - 取り下げは確認のシートを一段挟む(ChatMenuと同じ作り)。送信中は押せない
 * - 通信失敗(TypeError)は固定の案内を出し・スイッチは元の値へ戻す
 * - 日数の計算は now: Date を受ける関数に分け・時計は画面の入口でだけ読む
 */

import type { IntentDTO, LatchDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { useConnectionsQuery } from "../../chat/queries";
import {
	clearComposeState,
	savePendingCompose,
} from "../../intents/composeState";
import {
	INTENT_STATUS_LABELS,
	intentQueryKey,
	useDeleteIntent,
	useIntentQuery,
	usePatchIntent,
	usePauseIntent,
	useResumeIntent,
} from "../../intents/queries";
import { formatMonthDayJst } from "../../intents/submit";
import {
	formatHm,
	formatMd,
	formatWhen,
	formatYen,
	jstDayIndex,
} from "../../latches/format";
import { isOfflineError, OFFLINE_MESSAGES } from "../../offline/errors";
import { OfflineBanner } from "../../offline/OfflineBanner";
import { useOnline } from "../../offline/online";
import { intentEditPath, PATHS } from "../../routes/paths";
import { GlyphPaths } from "../Home";
import { RouteToast, useRouteToast } from "../RouteToast";
import { ScreenGrain } from "../shared";
import "./intent.css";
import { rateLimitMessage } from "../../api/rate-limit";

const DAY_MS = 24 * 3_600_000;
const TOAST_MS = 2400;

/** この意思でつながった件数(成立一覧のmy_intent_idが一致する件数) */
export const countMatches = (
	connections: LatchDTO[],
	intentId: string,
): number => connections.filter((c) => c.my_intent_id === intentId).length;

/** 預けてからの日数(切り捨て・負にならない) */
export const daysSince = (iso: string, now: Date): number =>
	Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));

/** 期限までの日数(切り上げ・負にならない) */
export const daysUntil = (iso: string, now: Date): number =>
	Math.max(0, Math.ceil((Date.parse(iso) - now.getTime()) / DAY_MS));

/** 「今日」「明日」「昨日」「M月D日」(開始・期限の帯の見出し用) */
const dayWord = (iso: string, now: Date): string => {
	const t = Date.parse(iso);
	const diff = jstDayIndex(t) - jstDayIndex(now.getTime());
	return diff === 0
		? "今日"
		: diff === 1
			? "明日"
			: diff === -1
				? "昨日"
				: formatMd(t);
};

const FORM_LABELS = { connection: "つながり", occasion: "機会" } as const;
const QUIET: ReadonlySet<string> = new Set(["draft", "expired", "cancelled"]);

const Icon = ({ d }: { d: string }) => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		<path d={d} />
	</svg>
);
const ICON_BACK = "M14.5 5.5L8 12l6.5 6.5";
const ICON_EDIT =
	"M5 19h3.6L18.3 9.3a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L5 15.4zM13.4 7l3.6 3.6";
const ICON_PAUSE = "M9 6.5v11M15 6.5v11";
const ICON_PLAY = "M8.5 6.2v11.6l9.2-5.8z";

function Fact({
	label,
	children,
	muted = false,
}: {
	label: string;
	children: ReactNode;
	muted?: boolean;
}) {
	return (
		<div className="fact">
			<dt className="fact__key">{label}</dt>
			<dd className={`fact__val${muted ? " fact__val--muted" : ""}`}>
				{children}
			</dd>
			<span />
		</div>
	);
}

const participantsText = (p: IntentDTO["participants"]): string =>
	p.min === p.max ? `${p.min}人(あなたと相手)` : `${p.min}〜${p.max}人`;

const budgetText = (b: IntentDTO["budget"]): string | null => {
	if (b === null) return null;
	return b.min > 0
		? `${formatYen(b.min)}〜${formatYen(b.max)}`
		: `${formatYen(b.max)}以内`;
};

function Topbar() {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<Link className="icon-btn" to={PATHS.home} aria-label="戻る">
					<Icon d={ICON_BACK} />
				</Link>
			</div>
			<span />
			<div className="topbar__side topbar__side--end" />
		</header>
	);
}

function NotFound() {
	return (
		<div className="screen intent-detail">
			<ScreenGrain />
			<Topbar />
			<div className="screen__body pad" style={{ paddingTop: 6 }}>
				<p className="t-caption" style={{ marginTop: 8 }}>
					見つかりませんでした
				</p>
				<Link
					className="btn btn--secondary"
					style={{ marginTop: 16 }}
					to={PATHS.home}
				>
					ホームへ戻る
				</Link>
			</div>
		</div>
	);
}

function LoadFailed({
	offline,
	onRetry,
}: {
	offline: boolean;
	onRetry(): void;
}) {
	return (
		<div className="screen intent-detail">
			<ScreenGrain />
			<Topbar />
			<div className="screen__body pad" style={{ paddingTop: 6 }}>
				{offline && <OfflineBanner />}
				<p className="t-caption" style={{ marginTop: 8 }}>
					読み込めませんでした。
				</p>
				<button
					type="button"
					className="btn btn--secondary"
					style={{ marginTop: 16 }}
					onClick={onRetry}
				>
					もう一度読み込む
				</button>
			</div>
		</div>
	);
}

/** 取り下げの確認(一段・ChatMenuと同じ作り) */
function CancelSheet({
	busy,
	onConfirm,
	onClose,
}: {
	busy: boolean;
	onConfirm(): void;
	onClose(): void;
}) {
	return (
		<>
			<div
				className="backdrop"
				aria-hidden="true"
				onClick={() => {
					if (!busy) onClose();
				}}
			/>
			<div
				className="sheet-layer"
				role="dialog"
				aria-modal="true"
				aria-label="取り下げの確認"
			>
				<div className="sheet">
					<span className="sheet__grab" aria-hidden="true" />
					<h2 className="sheet__title" style={{ fontSize: 19 }}>
						この意思を取り下げます。届いている提案も取り消されます。
					</h2>
					<div className="sheet__actions">
						<button
							type="button"
							className="btn btn--danger btn--block"
							disabled={busy}
							onClick={onConfirm}
						>
							取り下げる
						</button>
						<button
							type="button"
							className="btn btn--quiet btn--block"
							disabled={busy}
							onClick={onClose}
						>
							やめる
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

/** 400 invalid_status(状態がすでに変わっている) */
const isInvalidStatus = (error: unknown): boolean =>
	error instanceof ApiError &&
	error.code === "VALIDATION_FAILED" &&
	Array.isArray(error.details.reasons) &&
	error.details.reasons.includes("invalid_status");

function Detail({ intent, now }: { intent: IntentDTO; now: Date }) {
	const navigate = useNavigate();
	const client = useQueryClient();
	const id = intent.id;
	const pause = usePauseIntent(id);
	const resume = useResumeIntent(id);
	const patch = usePatchIntent(id);
	const del = useDeleteIntent(id);
	const connections = useConnectionsQuery();
	const matches = countMatches(
		connections.data?.pages.flatMap((p) => p.items) ?? [],
		id,
	);

	const routeToast = useRouteToast();
	const [toast, setToast] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sheet, setSheet] = useState(false);
	/** スイッチの送信中の値(送信中は画面の値をこちらにする) */
	const [pendingNotify, setPendingNotify] = useState<boolean | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	const say = (text: string) => {
		setToast(text);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setToast(null), TOAST_MS);
	};

	const busy =
		pause.isPending || resume.isPending || patch.isPending || del.isPending;
	const notify =
		pendingNotify ?? intent.notification_level === "proposals_only";

	/** 失敗の扱い: 状態の食い違いは取り直し・通信失敗は固定の案内・その他は一般の一文 */
	const fail = (error: unknown) => {
		if (isInvalidStatus(error)) {
			void client.invalidateQueries({ queryKey: intentQueryKey(id) });
			setNotice("状態が変わっていました。最新の内容を読み直しました。");
			return;
		}
		setNotice(
			rateLimitMessage(error) ??
				(isOfflineError(error)
					? OFFLINE_MESSAGES.generic
					: "うまくいきませんでした。もう一度お試しください。"),
		);
	};

	const togglePause = () => {
		if (busy) return;
		setNotice(null);
		const action = intent.status === "paused" ? resume : pause;
		action.mutate(undefined, {
			onSuccess: () =>
				say(
					intent.status === "paused" ? "再開しました。" : "一時停止しました。",
				),
			onError: fail,
		});
	};

	const toggleNotify = (next: boolean) => {
		if (busy || intent.status !== "active") return;
		setNotice(null);
		setPendingNotify(next);
		patch.mutate(
			{ notification_level: next ? "proposals_only" : "muted" },
			{
				onSuccess: () => setPendingNotify(null),
				onError: (error) => {
					setPendingNotify(null);
					fail(error);
				},
			},
		);
	};

	const doDelete = (toastText?: string) => {
		if (busy) return;
		setNotice(null);
		del.mutate(undefined, {
			onSuccess: () =>
				navigate(PATHS.home, {
					replace: true,
					state: toastText ? { toast: toastText } : null,
				}),
			onError: (error) => {
				setSheet(false);
				fail(error);
			},
		});
	};

	const redeposit = () => {
		clearComposeState();
		savePendingCompose({ raw_text: intent.raw_text, draft_id: null });
		navigate(PATHS.compose);
	};

	const occasion = intent.form === "occasion";
	const created = intent.created_at;
	const expires = intent.expires_at;
	const expired = intent.status === "expired";
	const live = intent.status === "active" || intent.status === "paused";
	const budget = budgetText(intent.budget);
	const dim = QUIET.has(intent.status);

	const stats =
		intent.status === "draft" || intent.form === null ? null : occasion ? (
			<div className="stats">
				<div>
					<p className="stats__k">
						{`開始・${intent.time ? dayWord(intent.time.start, now) : "—"}`}
					</p>
					<p className="stats__v">
						<b>{intent.time ? formatHm(Date.parse(intent.time.start)) : "—"}</b>
					</p>
				</div>
				<div>
					<p className="stats__k">
						{`期限・${expires ? dayWord(expires, now) : "—"}`}
					</p>
					<p className="stats__v">
						<b>{expires ? formatHm(Date.parse(expires)) : "—"}</b>
					</p>
				</div>
				<div>
					<p className="stats__k">これまで</p>
					<p className="stats__v">
						<b>{matches}</b>回つながった
					</p>
				</div>
			</div>
		) : (
			<div className="stats">
				<div>
					<p className="stats__k">預けて</p>
					<p className="stats__v">
						<b>{daysSince(created, now)}</b>日
					</p>
				</div>
				<div>
					<p className="stats__k">期限まで</p>
					<p className="stats__v">
						<b>{expired || !expires ? 0 : daysUntil(expires, now)}</b>日
					</p>
				</div>
				<div>
					<p className="stats__k">これまで</p>
					<p className="stats__v">
						<b>{matches}</b>回つながった
					</p>
				</div>
			</div>
		);

	const geoText = intent.geo === null ? null : "指定あり";
	const facts =
		intent.status === "draft" || intent.form === null ? null : occasion ? (
			<>
				<Fact label="主題">{intent.topic ?? "指定なし"}</Fact>
				<Fact label="日時">
					{intent.time ? `${formatWhen(intent.time.start, now)}〜` : "指定なし"}
				</Fact>
				<Fact label="場所" muted={geoText === null}>
					{geoText ?? "指定なし"}
				</Fact>
				<Fact label="人数">{participantsText(intent.participants)}</Fact>
				<Fact label="予算" muted={budget === null}>
					{budget ?? "指定なし"}
				</Fact>
				<Fact label="お酒">
					{intent.alcohol_involved ? "含む(20歳以上の方どうし)" : "含まない"}
				</Fact>
			</>
		) : (
			<>
				<Fact label="主題">{intent.topic ?? "指定なし"}</Fact>
				<div className="fact">
					<dt className="fact__key">条件</dt>
					<dd className="fact__val">
						{intent.soft_constraints.length === 0
							? "なし"
							: intent.soft_constraints.map((c, i) => (
									<span key={c}>
										{i > 0 ? <span className="sep">·</span> : null}
										{c}
									</span>
								))}
					</dd>
					<span />
				</div>
				<Fact label="地域" muted={geoText === null}>
					{geoText ?? "指定なし(全国)"}
				</Fact>
				<Fact label="人数">{participantsText(intent.participants)}</Fact>
				{expires ? (
					<Fact label="期限">
						{`${formatMonthDayJst(expires)}まで(${daysUntil(expires, now)}日)`}
					</Fact>
				) : null}
			</>
		);

	return (
		<div className="screen intent-detail">
			<ScreenGrain />
			<Topbar />
			<div
				className="screen__body pad"
				style={{ paddingTop: 4, paddingBottom: 28 }}
			>
				<div className="row" style={{ gap: 12 }}>
					<span className={`status${dim ? " status--quiet" : ""}`}>
						<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
							<GlyphPaths intent={intent} waiting={false} />
						</svg>
						{INTENT_STATUS_LABELS[intent.status]}
					</span>
					{intent.form !== null ? (
						<span className="t-label">{FORM_LABELS[intent.form]}</span>
					) : null}
				</div>
				<p
					className="t-words"
					style={{ fontSize: 21, lineHeight: 1.85, marginTop: 14 }}
				>
					{intent.raw_text}
				</p>
				{stats}
				{facts ? (
					<>
						<h2 className="t-label" style={{ marginTop: 30 }}>
							読み解いた条件
						</h2>
						<dl className="facts" style={{ marginTop: 8 }}>
							{facts}
						</dl>
					</>
				) : null}

				{live ? (
					<>
						<div className="setting-row" style={{ marginTop: 26 }}>
							<div>
								<p className="t-head">提案をお知らせする</p>
								<p className="t-caption">
									オフにすると通知はしません。提案は、預けている一覧に届きます。
								</p>
							</div>
							<div className="switch">
								<input
									type="checkbox"
									aria-label="この意思の提案をお知らせする"
									checked={notify}
									disabled={intent.status !== "active" || busy}
									onChange={(e) => toggleNotify(e.target.checked)}
								/>
								<span />
							</div>
						</div>
						<p className="t-caption" style={{ marginTop: 14 }}>
							{intent.status === "paused"
								? "一時停止中は、提案が届きません。"
								: "一時停止しているあいだは、提案が届きません。"}
							いつでも再開できます。
						</p>
					</>
				) : null}
				{expired ? (
					<p className="t-caption" style={{ marginTop: 18 }}>
						{expires ? `${formatMonthDayJst(expires)}に` : ""}
						期限が切れました。同じ内容で、もう一度預けられます。
					</p>
				) : null}
				{notice !== null ? (
					<p className="note" role="alert" style={{ marginTop: 16 }}>
						{notice}
					</p>
				) : null}

				<div className="stack intent-actions">
					{live ? (
						<>
							<button
								type="button"
								className={`btn btn--block ${intent.status === "paused" ? "btn--primary" : "btn--secondary"}`}
								disabled={busy}
								onClick={togglePause}
							>
								<Icon d={intent.status === "paused" ? ICON_PLAY : ICON_PAUSE} />
								{intent.status === "paused" ? "再開する" : "一時停止する"}
							</button>
							{intent.status === "active" ? (
								<Link
									className="btn btn--secondary btn--block"
									to={intentEditPath(id)}
								>
									<Icon d={ICON_EDIT} />
									内容を直す
								</Link>
							) : null}
							<button
								type="button"
								className="btn btn--quiet t-danger"
								disabled={busy}
								onClick={() => setSheet(true)}
							>
								取り下げる
							</button>
						</>
					) : null}
					{expired ? (
						<>
							<button
								type="button"
								className="btn btn--primary btn--block"
								onClick={redeposit}
							>
								もう一度預ける
							</button>
							<button
								type="button"
								className="btn btn--quiet"
								disabled={busy}
								onClick={() => doDelete()}
							>
								一覧から消す
							</button>
						</>
					) : null}
					{intent.status === "draft" ? (
						<Link
							className="btn btn--primary btn--block"
							to={`${PATHS.compose}?draft=${id}`}
						>
							続きを書く
						</Link>
					) : null}
				</div>
			</div>
			<RouteToast text={toast ?? routeToast} />
			{sheet ? (
				<CancelSheet
					busy={del.isPending}
					onConfirm={() => doDelete("取り下げました。")}
					onClose={() => setSheet(false)}
				/>
			) : null}
		</div>
	);
}

export function IntentDetail() {
	const { id = "" } = useParams();
	const { data, isPending, isError, error, refetch } = useIntentQuery(id);
	const online = useOnline();
	if (isError && !data) {
		return error instanceof ApiError && error.code === "NOT_FOUND" ? (
			<NotFound />
		) : (
			<LoadFailed offline={!online} onRetry={() => void refetch()} />
		);
	}
	// 単一の取得は端末に保存しないので、オフラインで開くと取得が止まったままになる。
	// 空の画面にせず、読み込めなかった表示と帯を出す
	if (!online && !data) {
		return <LoadFailed offline onRetry={() => void refetch()} />;
	}
	if (isPending || !data) {
		return (
			<div className="screen intent-detail">
				<ScreenGrain />
			</div>
		);
	}
	return <Detail intent={data} now={new Date()} />;
}
