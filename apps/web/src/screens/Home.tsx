/**
 * 預けている画面(ボード: Home.dc.html・HomeEmpty.dc.htmlの移植)。
 * - 一覧はTanStack Query(useIntentsQuery)で取得(docs/05 §3.3・limit=50・F2'では次ページなし)
 * - カードは .intent(wordsは2行clamp)・formラベル(つながり/機会)・状態表示名(01 §10対照)
 * - 下書きカードは /compose?draft=<id> への再開導線・それ以外のカードの詳細はF3以降のため表示のみ
 * - 進行中の提案は到着カード(arrival)として見出しの後に並べ・提案先の意思カードは「回答を待っています」にする(F4c設計)。
 *   器の灯りは未回答の提案があるときだけ。提案の取得中・失敗時は到着カードを出さず意思の一覧だけ表示する
 * - ブラウザで通知が拒否済みのときは「通知がオフです」の帯と[設定]を出す(設計書 §3.1・PushOff.dc.html)
 * - 右上はお知らせ(未読の点つき)と自分への入口(TopbarActions)
 * - 取得失敗時は再試行を出す(ボードに通信エラー画面がないための共通表示・実装の裁量)
 */

import type { IntentDTO, IntentStatus, LatchDTO } from "@latch/shared";
import { useIsRestoring } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { Link } from "react-router";
import { useDesktop } from "../desktop/context";
import { INTENT_STATUS_LABELS, useIntentsQuery } from "../intents/queries";
import { formatWhen } from "../latches/format";
import { useProposalsQuery } from "../latches/queries";
import { isOfflineError } from "../offline/errors";
import { OfflineBanner } from "../offline/OfflineBanner";
import { useOnline } from "../offline/online";
import { usePushStatus } from "../push/subscription";
import { intentPath, latchPath, PATHS } from "../routes/paths";
import { LatchArt } from "./latch/art";
import { RouteToast, useRouteToast } from "./RouteToast";
import { ScreenGrain } from "./shared";
import { TabBar } from "./TabBar";
import { TopbarActions } from "./TopbarActions";

const DAY_MS = 24 * 3_600_000;

/** formの表示ラベル(docs/01 §5の表示語対照) */
const FORM_LABELS = {
	connection: "つながり",
	occasion: "機会",
} as const;

/** 下書き・期限切れの区分に入る状態(薄表示。取り下げも同じ控えめ扱いにする) */
const QUIET_STATUSES: ReadonlySet<IntentStatus> = new Set([
	"draft",
	"expired",
	"cancelled",
]);

/** JST(+9時間)の壁時計としてISO時刻の日時部を読む */
const jstParts = (value: string) => {
	const shifted = new Date(new Date(value).getTime() + 9 * 3_600_000);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		date: shifted.getUTCDate(),
		hours: shifted.getUTCHours(),
		minutes: shifted.getUTCMinutes(),
	};
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 2つの時刻がJSTの壁時計で同じ日か */
const isSameJstDay = (a: string, b: string): boolean => {
	const pa = jstParts(a);
	const pb = jstParts(b);
	return pa.year === pb.year && pa.month === pb.month && pa.date === pb.date;
};

/** 開始までの残り(ボードの「1時間40分」形式) */
const formatRemain = (ms: number): string => {
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
};

/** 状態チップの色分け。灯りは提案が届いた(回答待ち)のみ・activeは通常の墨色
 * (README §3・DSLatchボードの規定)。Intentの状態に提案中は無いため・waitingで受ける */
const statusClass = (intent: IntentDTO, waiting: boolean): string => {
	if (QUIET_STATUSES.has(intent.status)) {
		return "status status--quiet";
	}
	if (waiting) {
		return "status status--lamp";
	}
	return "status";
};

/** カードの半円グリフ(状態ごとにボードの意匠を出し分ける)。
 * activeはformを問わずgt/gm(DSLatchボードのactive表現)・灯りのgl/gmは回答待ちのみ */
export function GlyphPaths({
	intent,
	waiting,
}: {
	intent: IntentDTO;
	waiting: boolean;
}) {
	if (intent.status === "draft") {
		return <path className="gd" d="M9.4 2.4A7.6 7.6 0 0 0 9.4 17.6Z" />;
	}
	if (intent.status === "expired") {
		return <path className="go" d="M9.4 2.4A7.6 7.6 0 0 0 9.4 17.6Z" />;
	}
	if (intent.status === "paused") {
		return (
			<>
				<path className="gt" d="M10.9 1.5A8.5 8.5 0 0 1 10.9 18.5" />
				<path className="gp" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
			</>
		);
	}
	if (waiting) {
		return (
			<>
				<path className="gl" d="M11.3 1.5A8.5 8.5 0 0 1 11.3 18.5Z" />
				<path className="gm" d="M8.7 1.5A8.5 8.5 0 0 0 8.7 18.5Z" />
			</>
		);
	}
	return (
		<>
			<path className="gt" d="M10.9 1.5A8.5 8.5 0 0 1 10.9 18.5" />
			<path className="gm" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
		</>
	);
}

/** カード下部の時間表示(経過バー・開始まで・保存日時など) */
function IntentTime({ intent, now }: { intent: IntentDTO; now: Date }) {
	if (intent.status === "draft") {
		const days = Math.floor(
			(now.getTime() - Date.parse(intent.updated_at)) / DAY_MS,
		);
		return (
			<span className="t-meta">
				{days <= 0 ? "今日保存" : `${days}日前に保存`}
			</span>
		);
	}
	if (intent.status === "expired") {
		const p = jstParts(intent.expires_at ?? intent.updated_at);
		return (
			<span className="t-meta">{`${p.month}月${p.date}日に期限切れ`}</span>
		);
	}
	// 機会Intentは開始時刻と開始までの残り(ボードの「今日 20:00〜 / 開始まで…」)
	if (intent.time !== null) {
		const p = jstParts(intent.time.start);
		const hhmm = `${pad2(p.hours)}:${pad2(p.minutes)}`;
		const dayLabel = isSameJstDay(intent.time.start, now.toISOString())
			? `今日 ${hhmm}〜`
			: `${p.month}月${p.date}日 ${hhmm}〜`;
		const remainMs = Date.parse(intent.time.start) - now.getTime();
		return (
			<span className="timeline__labels t-meta" style={{ marginTop: 0 }}>
				<span>
					<svg className="ic ic--xs" viewBox="0 0 24 24" aria-hidden="true">
						<rect x="4.5" y="5.5" width="15" height="14" rx="2.5" />
						<path d="M4.5 9.8h15M8.5 3.8v3.4M15.5 3.8v3.4" />
					</svg>
					{` ${dayLabel}`}
				</span>
				{remainMs > 0 && <span>{`開始まで ${formatRemain(remainMs)}`}</span>}
			</span>
		);
	}
	// つながりIntentは経過バーと預けて/あと(日数)
	const created = Date.parse(intent.created_at);
	if (intent.expires_at === null) {
		return null;
	}
	const expires = Date.parse(intent.expires_at);
	if (Number.isNaN(created) || Number.isNaN(expires) || expires <= created) {
		return null;
	}
	const elapsed = now.getTime() - created;
	const width = `${(Math.min(1, Math.max(0, elapsed / (expires - created))) * 100).toFixed(1)}%`;
	const sinceDays = Math.max(1, Math.floor(elapsed / DAY_MS));
	const untilDays = Math.max(0, Math.ceil((expires - now.getTime()) / DAY_MS));
	return (
		<>
			<span className="timeline" aria-hidden="true">
				<span className="timeline__done" style={{ width }} />
				<span className="timeline__now" style={{ left: width }} />
			</span>
			<span className="timeline__labels t-meta">
				<span>{`預けて${sinceDays}日`}</span>
				<span>{`あと${untilDays}日`}</span>
			</span>
		</>
	);
}

/** 一覧の1カード。下書きだけ既存のcomposeへの再開リンクになる。
 * riseClassはentranceの「rise rise-N」の両クラス(.riseがアニメーション本体・.rise-Nは遅延) */
function IntentCard({
	intent,
	now,
	riseClass,
	waiting,
}: {
	intent: IntentDTO;
	now: Date;
	riseClass: string;
	waiting: boolean;
}) {
	const dim = QUIET_STATUSES.has(intent.status);
	const body = (
		<>
			<span className="intent__glyph">
				<svg className="glyph glyph--l" viewBox="0 0 20 20" aria-hidden="true">
					<GlyphPaths intent={intent} waiting={waiting} />
				</svg>
			</span>
			<span className="stack">
				<span className="intent__words clamp-2">{intent.raw_text}</span>
				<span className="intent__meta">
					{intent.form !== null && (
						<span className="t-label">{FORM_LABELS[intent.form]}</span>
					)}
					<span className={statusClass(intent, waiting)}>
						<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
							<GlyphPaths intent={intent} waiting={waiting} />
						</svg>
						{waiting && !dim
							? "回答を待っています"
							: INTENT_STATUS_LABELS[intent.status]}
					</span>
				</span>
				<span className="intent__time">
					<IntentTime intent={intent} now={now} />
				</span>
			</span>
		</>
	);
	if (intent.status === "draft") {
		return (
			<li>
				<Link
					className={`intent is-dim ${riseClass}`}
					to={`${PATHS.compose}?draft=${intent.id}`}
				>
					{body}
				</Link>
			</li>
		);
	}
	return (
		<li>
			<Link
				className={`intent${dim ? " is-dim" : ""} ${riseClass}`}
				to={intentPath(intent.id)}
			>
				{body}
			</Link>
		</li>
	);
}

/** 提案の到着カード(prototype arrivalBlock)。yes済みは相手の回答待ちで押した状態 */
function ArrivalCard({ latch, now }: { latch: LatchDTO; now: Date }) {
	const pressed = latch.my_response === "yes";
	// PCで右の提案の部屋に出している提案は、矢印の代わりにそのことを示す(Desktop.dc.html)
	const inRoom = useDesktop().roomLatchId === latch.id;
	return (
		<Link
			className={`arrival${pressed ? " is-pressed" : ""} rise`}
			to={latchPath(latch.id)}
		>
			<LatchArt state={pressed ? "pressed" : "arrived"} size={40} gap={5} />
			<span className="stack" style={{ gap: 2 }}>
				<span className="arrival__title">
					{pressed ? "相手の回答を待っています" : "提案が届いています"}
				</span>
				<span className="t-meta">
					{`回答期限 ${formatWhen(latch.response_deadline, now)} まで`}
					{latch.participants_count > 2 && (
						<>
							<span className="sep">·</span>
							{`${latch.participants_count}人`}
						</>
					)}
				</span>
			</span>
			{inRoom ? (
				<span className="t-label arrival__aside">右に表示中</span>
			) : (
				<svg className="ic ic--s" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M9.5 6l6 6-6 6" />
				</svg>
			)}
		</Link>
	);
}

/** トップバー。brand・お知らせ・自分は表示のみ(遷移先はF7スコープ) */
function HomeTopbar() {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<span className="brand">
					<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
						<path className="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z" />
						<path
							className="mark__theirs"
							d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z"
						/>
					</svg>
					<span className="brand__word">LATCH</span>
				</span>
			</div>
			<span />
			<div className="topbar__side topbar__side--end">
				<TopbarActions />
			</div>
		</header>
	);
}

/** 通知が拒否済みの帯(PushOff.dc.htmlの移植) */
function PushOffBanner() {
	return (
		<p className="banner" style={{ marginBottom: 12 }}>
			<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M8.4 6.9a5.5 5.5 0 0 1 9.1 4.4v5.2l1.6 1.9H9.6" />
				<path d="M6.5 11.3v5.2l-1.6 1.9H15" />
				<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
				<path d="M4 4l16 16" />
			</svg>
			<span>通知がオフです。提案はアプリ内のお知らせでお伝えします。</span>
			<Link className="link" to={PATHS.settings} style={{ fontSize: 13 }}>
				設定
			</Link>
		</p>
	);
}

export function Home() {
	const toast = useRouteToast();
	const { data, isPending, isRefetchError, error, refetch } = useIntentsQuery();
	const online = useOnline();
	const restoring = useIsRestoring();
	// オフライン中・または再取得が通信失敗で、保存済みの一覧を見せているとき
	const offline = !online || (isRefetchError && isOfflineError(error));
	const pushDenied = usePushStatus().data === "denied";
	// 提案の取得中・失敗は空として扱い・意思の一覧だけを出す
	const proposals = useProposalsQuery().data?.items ?? [];
	const waitingIntentIds = new Set(
		proposals.flatMap((latch) =>
			latch.my_intent_id === null ? [] : [latch.my_intent_id],
		),
	);
	const hasUnanswered = proposals.some((latch) => latch.my_response === null);
	// 相対表示(預けてN日・開始まで など)の基準時刻
	const now = new Date();

	// オフラインで保存済みの一覧が無いときは、取得が止まったままなので読み込めなかった表示にする。
	// ただし端末の保存を読み戻している間は、読み戻しを待って取得中の表示にする
	if (isPending && (online || restoring)) {
		return (
			<div className="screen home">
				<ScreenGrain />
				<RouteToast text={toast} />
				<HomeTopbar />
				<div className="screen__body" style={{ paddingBottom: 132 }}>
					<div className="pad" style={{ paddingTop: 6, paddingBottom: 18 }}>
						<h1 className="t-display">預けている</h1>
					</div>
				</div>
				<TabBar current="home" />
			</div>
		);
	}

	if (data === undefined) {
		return (
			<div className="screen home">
				<ScreenGrain />
				<RouteToast text={toast} />
				<HomeTopbar />
				<div className="screen__body pad" style={{ paddingTop: 6 }}>
					<h1 className="t-display">預けている</h1>
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
				</div>
				<TabBar current="home" />
			</div>
		);
	}

	if (data.items.length === 0 && proposals.length === 0) {
		return (
			<div className="screen home home--empty">
				<ScreenGrain />
				<RouteToast text={toast} />
				<HomeTopbar />
				<div
					className="screen__body pad"
					style={{
						display: "flex",
						flexDirection: "column",
						paddingBottom: 140,
					}}
				>
					<div style={{ flex: 1, minHeight: 40 }} />
					<div className="rise" style={{ alignSelf: "center" }}>
						<div
							className="latch is-empty"
							style={{ "--size": "210px", "--gap": "18px" } as CSSProperties}
							aria-hidden="true"
						>
							<span className="latch__light" />
							<span className="latch__mine" />
							<span className="latch__theirs">
								<span className="latch__ink" />
							</span>
						</div>
					</div>
					<div style={{ flex: 1, minHeight: 40 }} />
					<h1 className="t-display t-display--s rise rise-1">
						まだ、何も置いていません。
					</h1>
					<p className="t-body rise rise-2" style={{ marginTop: 12 }}>
						ふと浮かんだ「繋がりたい」を、ひとことだけ置いておけます。届くまでは、待つだけです。
					</p>
					<Link
						className="btn btn--primary rise rise-3"
						style={{ marginTop: 28, alignSelf: "flex-start" }}
						to={PATHS.compose}
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M12 5.5v13M5.5 12h13" />
						</svg>
						ひとこと置く
					</Link>
				</div>
				<TabBar current="home" />
			</div>
		);
	}

	const entrusted = data.items.filter(
		(intent) => !QUIET_STATUSES.has(intent.status),
	);
	const quiet = data.items.filter((intent) =>
		QUIET_STATUSES.has(intent.status),
	);
	const activeCount = data.items.filter(
		(intent) => intent.status === "active",
	).length;

	return (
		<div className="screen home">
			<ScreenGrain />
			<RouteToast text={toast} />
			<div
				className={`vessel vessel--quiet${hasUnanswered ? " is-lit" : ""}`}
				style={{ width: 340, height: 340, right: -176, top: -128 }}
				aria-hidden="true"
			/>
			<HomeTopbar />
			<div className="screen__body" style={{ paddingBottom: 132 }}>
				<div className="pad" style={{ paddingTop: 6, paddingBottom: 18 }}>
					<h1 className="t-display rise">預けている</h1>
					<p className="t-caption rise rise-1">
						{activeCount === 0
							? "いま、預けている意思はありません。"
							: `いま、${activeCount}つの意思を預けています。`}
					</p>
				</div>
				{offline && <OfflineBanner />}
				{pushDenied && !offline && <PushOffBanner />}
				{proposals.map((latch) => (
					<ArrivalCard key={latch.id} latch={latch} now={now} />
				))}
				<ul>
					{entrusted.map((intent, index) => (
						<IntentCard
							key={intent.id}
							intent={intent}
							now={now}
							riseClass={`rise rise-${Math.min(5, index + 1)}`}
							waiting={waitingIntentIds.has(intent.id)}
						/>
					))}
				</ul>
				{quiet.length > 0 && (
					<>
						<h2 className="list__head t-label">下書き・期限切れ</h2>
						<ul>
							{quiet.map((intent, index) => (
								<IntentCard
									key={intent.id}
									intent={intent}
									now={now}
									riseClass={`rise rise-${Math.min(5, index + 4)}`}
									waiting={false}
								/>
							))}
						</ul>
					</>
				)}
				<p className="home__foot t-caption">
					<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
						<path className="gt" d="M10.9 1.5A8.5 8.5 0 0 1 10.9 18.5" />
						<path className="gm" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
					</svg>
					合う相手が現れたときだけ、ここに届きます。
				</p>
			</div>
			<TabBar current="home" />
		</div>
	);
}
