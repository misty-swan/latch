/**
 * /latches/:idの親画面(F4c設計 §1.2〜§1.4)。LATCH1件を取得し・§1.2の表で子の表示を選ぶ。
 * 回答(参加する・今回は見送る)・取り消しの送信と動き、送信失敗時の取り直しと一文、
 * 回答待ちの30秒ごとの取り直し、その場で見届けた成立だけの演出(fresh)を担う。
 */

import type { LatchDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { rateLimitMessage } from "../../api/rate-limit";
import {
	latchQueryKey,
	useLatchQuery,
	useRespondMutation,
	useRetractMutation,
} from "../../latches/queries";
import { isOfflineError, OFFLINE_MESSAGES } from "../../offline/errors";
import { chatPath, latchShelvedPath, PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { Awaiting } from "./Awaiting";
import { Matched } from "./Matched";
import { NotEstablished } from "./NotEstablished";
import { Proposal } from "./Proposal";

export type LatchView =
	| "proposal"
	| "awaiting"
	| "matched"
	| "shelved"
	| "closed"
	| "ended";

/** 回答待ちの定期取得の間隔(F4c設計 §1.3) */
const AWAIT_POLL_MS = 30_000;
/** 押し込み・棚へ戻す動きの長さ(latch.cssのis-pressed・is-shelvingの遷移) */
const PRESS_MS = 520;
const SHELVE_MS = 760;

/** もう回答できないことを表す400の理由(docs/05 §3.4) */
const CLOSED_REASONS: ReadonlySet<string> = new Set([
	"deadline_passed",
	"invalid_status",
	"already_responded",
]);

/** §1.2の表(上の行から順に判定・deferは状態より先) */
export function selectLatchView(latch: LatchDTO): LatchView {
	if (latch.my_response === "defer") return "shelved";
	if (latch.status === "proposed" || latch.status === "partial_accept") {
		if (latch.my_response === null) return "proposal";
		if (latch.my_response === "yes") return "awaiting";
	}
	if (latch.status === "matched") return "matched";
	// 成立を経て終わったもの(離脱等のcancelled・completed)は「このつながりは終了しました」
	if (
		(latch.status === "cancelled" || latch.status === "completed") &&
		latch.proposal !== undefined
	) {
		return "ended";
	}
	return "closed";
}

const isNotFound = (error: unknown): boolean =>
	error instanceof ApiError && error.code === "NOT_FOUND";

/** 送信失敗の一文。締め切られた提案か・それ以外(通信失敗等)かで分ける */
const noticeFor = (error: unknown): string => {
	if (isOfflineError(error)) return OFFLINE_MESSAGES.generic;
	const limited = rateLimitMessage(error);
	if (limited !== null) return limited;
	const reasons = error instanceof ApiError ? error.details.reasons : undefined;
	if (
		Array.isArray(reasons) &&
		reasons.some((r) => typeof r === "string" && CLOSED_REASONS.has(r))
	) {
		return "この提案には、もう回答できません。";
	}
	return "送れませんでした。もう一度お試しください。";
};

const prefersReducedMotion = (): boolean =>
	window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** 動きを見せてから送る(prefers-reduced-motionでは待たない) */
const waitMotion = (ms: number): Promise<void> =>
	prefersReducedMotion()
		? Promise.resolve()
		: new Promise((resolve) => setTimeout(resolve, ms));

/** 取得失敗(404以外)。Homeの失敗表示と同じ形 */
export function LatchLoadFailed({ onRetry }: { onRetry(): void }) {
	return (
		<div className="screen">
			<ScreenGrain />
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
			<div className="screen__body pad" style={{ paddingTop: 6 }}>
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

/** latchIdを渡すと、URLではなくそのLATCHを描く(PCの右の提案の部屋・LAT-14) */
export function LatchScreen({ latchId }: { latchId?: string } = {}) {
	const params = useParams();
	const id = latchId ?? params.id ?? "";
	const client = useQueryClient();
	// 定期取得の要否は直前に取れた状態で決める(回答待ちの間だけ30秒ごと)
	const cached = client.getQueryData<LatchDTO>(latchQueryKey(id));
	const polling =
		cached !== undefined && selectLatchView(cached) === "awaiting";
	const query = useLatchQuery(id, {
		refetchInterval: polling ? AWAIT_POLL_MS : false,
	});
	const respond = useRespondMutation(id);
	const retract = useRetractMutation(id);

	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const artRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	/**
	 * 直前に描いた表示・自分の[参加する]の応答をまだ描いていないか・成立の演出を出すか。
	 * 応答の反映(setQueryData)による再描画はmutateAsyncの解決より後になりうるため、
	 * joiningRefは送信の後始末では下ろさず・提案以外の表示を最初に描いた時点で下ろす
	 */
	const prevViewRef = useRef<LatchView | null>(null);
	const joiningRef = useRef(false);
	const freshRef = useRef(false);

	const data = query.data;
	const view = data ? selectLatchView(data) : null;
	// その場で見届けた成立(回答待ちから・または自分の参加の応答で)だけ演出する
	if (
		view === "matched" &&
		(prevViewRef.current === "awaiting" || joiningRef.current)
	) {
		freshRef.current = true;
	}
	if (view !== null && view !== "proposal") joiningRef.current = false;
	// キャッシュの古い表示(開き直した直後・取り直し前)は「見届けた」に数えない
	if (view !== null && query.isFetchedAfterMount) prevViewRef.current = view;

	/** 送信の共通処理。失敗したら取り直して一文を出す */
	const run = async (action: () => Promise<unknown>, undo: () => void) => {
		if (busy) return;
		setBusy(true);
		setNotice(null);
		try {
			await action();
		} catch (error) {
			undo();
			setNotice(noticeFor(error));
			void query.refetch();
		} finally {
			setBusy(false);
		}
	};

	const onJoin = () => {
		const el = artRef.current;
		void run(
			async () => {
				el?.classList.remove("is-arrived");
				el?.classList.add("is-pressed");
				await waitMotion(PRESS_MS);
				joiningRef.current = true;
				await respond.mutateAsync("yes");
			},
			() => {
				joiningRef.current = false;
				el?.classList.remove("is-pressed");
				el?.classList.add("is-arrived");
			},
		);
	};

	const onDefer = () => {
		const el =
			artRef.current ??
			containerRef.current?.querySelector<HTMLElement>(".group-wrap") ??
			null;
		// 成功すると応答のmy_response=deferで見送った画面へ置き換わる(下のNavigate)
		void run(
			async () => {
				el?.classList.add("is-shelving");
				await waitMotion(SHELVE_MS);
				await respond.mutateAsync("defer");
			},
			() => el?.classList.remove("is-shelving"),
		);
	};

	const onRetract = () => {
		void run(
			() => retract.mutateAsync(),
			() => {},
		);
	};

	if (isNotFound(query.error)) return <NotEstablished variant="not_found" />;
	if (!data || view === null) {
		if (query.isPending) {
			return <div className="screen room" data-theme="dark" />;
		}
		return <LatchLoadFailed onRetry={() => void query.refetch()} />;
	}

	const now = new Date();
	switch (view) {
		case "shelved":
			return <Navigate to={latchShelvedPath(id)} replace />;
		case "proposal":
			return (
				<div ref={containerRef} style={{ display: "contents" }}>
					<Proposal
						latch={data}
						now={now}
						busy={busy}
						notice={notice}
						onJoin={onJoin}
						onDefer={onDefer}
						artRef={artRef}
					/>
				</div>
			);
		case "awaiting":
			return (
				<Awaiting
					latch={data}
					now={now}
					busy={busy}
					notice={notice}
					onRetract={onRetract}
				/>
			);
		case "matched":
			return (
				<Matched
					latch={data}
					now={now}
					fresh={freshRef.current}
					notice={notice}
				/>
			);
		case "ended":
			return (
				<NotEstablished
					variant="ended"
					notice={notice}
					chatTo={chatPath(data.id)}
				/>
			);
		case "closed":
			return <NotEstablished variant="closed" notice={notice} />;
	}
}
