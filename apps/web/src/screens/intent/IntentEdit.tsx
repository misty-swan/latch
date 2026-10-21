/**
 * 内容を直す(/intents/:id/edit・F8a設計 §1.4)。activeな意思をPATCHで直す画面。
 * - 見た目は読み解き確認(Confirm)の topbar・本文・「読み解いた条件」に揃える(ボード無し・実装の裁量)
 * - 直せるのは主題・日時・人数・予算(機会)・条件(つながり)だけ。預け方・期限・地域・お酒は表示のみ
 * - [直して預ける]は変わった項目だけをPATCHする。変化が無ければ確認もPATCHも無く詳細へ戻る。
 *   変化があれば「直すと、届いている提案は取り消されます。」の確認を一段挟む(ChatMenuと同じ作り)
 * - version_conflictは単一取得をやり直し、取り直したあとに最新の内容で画面を作り直す。
 *   active以外の意思で開いたときは詳細へreplaceで戻す
 */

import type { IntentDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { FactsEditor } from "../../intents/FactsEditor";
import {
	intentQueryKey,
	useIntentQuery,
	usePatchIntent,
} from "../../intents/queries";
import {
	buildIntentEditPatch,
	confirmValuesFromIntent,
	type FactsValues,
	formatExpiryClockJst,
	formatMonthDayJst,
	REASON_MESSAGES,
	validateConfirmValues,
} from "../../intents/submit";
import { isOfflineError, OFFLINE_MESSAGES } from "../../offline/errors";
import { intentPath } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { daysUntil } from "./IntentDetail";
import "./intent.css";

const VERSION_CONFLICT_MESSAGE =
	"ほかの画面で変更されました。最新の内容を読み直しました。";

/** 400 VALIDATION_FAILEDのreasons(文字列だけ) */
const reasonsOf = (error: unknown): string[] => {
	if (!(error instanceof ApiError) || error.code !== "VALIDATION_FAILED") {
		return [];
	}
	const raw = error.details.reasons;
	return Array.isArray(raw)
		? raw.filter((r): r is string => typeof r === "string")
		: [];
};

function Topbar({ id }: { id: string }) {
	return (
		<header className="topbar">
			<div className="topbar__side">
				<Link className="icon-btn" to={intentPath(id)} aria-label="戻る">
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M14.5 5.5L8 12l6.5 6.5" />
					</svg>
				</Link>
			</div>
			<span />
			<div className="topbar__side topbar__side--end" />
		</header>
	);
}

/** 保存前の確認(一段・ChatMenuと同じ作り) */
function SaveSheet({
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
				aria-label="直す前の確認"
			>
				<div className="sheet">
					<span className="sheet__grab" aria-hidden="true" />
					<h2 className="sheet__title" style={{ fontSize: 19 }}>
						直すと、届いている提案は取り消されます。
					</h2>
					<div className="sheet__actions">
						<button
							type="button"
							className="btn btn--primary btn--block"
							disabled={busy}
							onClick={onConfirm}
						>
							直して預ける
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

function Editor({
	intent,
	notice: inheritedNotice,
	onStale,
}: {
	intent: IntentDTO;
	notice: string | null;
	/** version_conflict: 親が取り直しと案内を受け持つ */
	onStale(): void;
}) {
	const navigate = useNavigate();
	const client = useQueryClient();
	const id = intent.id;
	const patch = usePatchIntent(id);
	const initial = confirmValuesFromIntent(intent);
	const form = initial.form;
	const [facts, setFacts] = useState<FactsValues>(() => ({
		topic: initial.topic,
		startLocal: initial.startLocal,
		participants: initial.participants,
		budget: initial.budget,
		softConstraints: initial.softConstraints,
		alcoholInvolved: initial.alcoholInvolved,
	}));
	const [errors, setErrors] = useState<{ topic?: string; start?: string }>({});
	const [messages, setMessages] = useState<string[]>([]);
	const [pending, setPending] = useState<ReturnType<
		typeof buildIntentEditPatch
	> | null>(null);

	const back = (toast?: string) =>
		navigate(intentPath(id), { state: toast ? { toast } : null });

	/** [直して預ける]: 検証→変化なしは詳細へ戻る→確認のシート */
	const onSave = () => {
		if (patch.isPending) return;
		setMessages([]);
		const request = buildIntentEditPatch(intent, facts);
		if (request === null) {
			back();
			return;
		}
		const found = validateConfirmValues({ ...initial, ...facts, form });
		// 日時は直したときだけ確かめる(変えていない過去の開始で止めない)
		const next = {
			topic: found.topic,
			start: request.time === undefined ? undefined : found.start,
		};
		setErrors(next);
		if (next.topic !== undefined || next.start !== undefined) return;
		setPending(request);
	};

	const onConfirm = () => {
		if (pending === null || pending === undefined) return;
		patch.mutate(pending, {
			onSuccess: () => back("直しました。"),
			onError: (error) => {
				setPending(null);
				const reasons = reasonsOf(error);
				if (reasons.includes("version_conflict")) {
					onStale();
					return;
				}
				if (reasons.includes("invalid_status")) {
					// 状態がすでに変わっている。取り直すと詳細へ戻る
					void client.invalidateQueries({ queryKey: intentQueryKey(id) });
					return;
				}
				if (reasons.length > 0) {
					setMessages(reasons.map((r) => REASON_MESSAGES[r] ?? r));
				} else if (isOfflineError(error)) {
					setMessages([OFFLINE_MESSAGES.generic]);
				} else {
					setMessages(["うまくいきませんでした。もう一度お試しください。"]);
				}
			},
		});
	};

	return (
		<div className="screen confirm intent-edit">
			<ScreenGrain />
			<Topbar id={id} />
			<div
				className="screen__body pad"
				style={{ paddingTop: 4, paddingBottom: 24 }}
			>
				<h1 className="t-display t-display--s">内容を直す</h1>
				<p
					className="t-words"
					style={{ fontSize: 17, lineHeight: 1.85, marginTop: 14 }}
				>
					{intent.raw_text}
				</p>
				<section style={{ marginTop: 28 }}>
					<h2 className="t-label">預け方</h2>
					<p className="t-body" style={{ marginTop: 8, color: "var(--ink)" }}>
						{form === "occasion" ? "機会" : "つながり"}
					</p>
				</section>
				<section style={{ marginTop: 30 }}>
					<h2 className="t-label">読み解いた条件</h2>
					<dl className="facts" style={{ marginTop: 8 }}>
						<FactsEditor
							form={form}
							values={facts}
							errors={errors}
							readOnly={["alcohol"]}
							onChange={setFacts}
						/>
					</dl>
				</section>
				{intent.expires_at !== null && (
					<section style={{ marginTop: 30 }}>
						<h2 className="t-label">期限</h2>
						<p className="t-body" style={{ marginTop: 8, color: "var(--ink)" }}>
							{form === "occasion"
								? formatExpiryClockJst(intent.expires_at, new Date())
								: `${formatMonthDayJst(intent.expires_at)}まで(${daysUntil(intent.expires_at, new Date())}日)`}
						</p>
					</section>
				)}
			</div>
			<div className="screen__foot">
				{inheritedNotice !== null && (
					<p className="note" role="alert">
						{inheritedNotice}
					</p>
				)}
				{messages.map((message) => (
					<p key={message} className="field__error" role="alert">
						{message}
					</p>
				))}
				<button
					type="button"
					className="btn btn--primary btn--block"
					onClick={onSave}
					disabled={patch.isPending}
				>
					直して預ける
				</button>
			</div>
			{pending !== null && (
				<SaveSheet
					busy={patch.isPending}
					onConfirm={onConfirm}
					onClose={() => setPending(null)}
				/>
			)}
		</div>
	);
}

export function IntentEdit() {
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const { data, isError, refetch } = useIntentQuery(id);
	const [notice, setNotice] = useState<string | null>(null);
	/** 取り直したあとに値を作り直すための印(保存成功の再描画では作り直さない) */
	const [generation, setGeneration] = useState(0);
	const inactive = data !== undefined && data.status !== "active";
	useEffect(() => {
		// 直せるのはactiveだけ。それ以外・見つからない意思は詳細へ戻す
		if (inactive || (isError && data === undefined)) {
			navigate(intentPath(id), { replace: true });
		}
	}, [inactive, isError, data, id, navigate]);
	if (data === undefined || inactive) {
		return (
			<div className="screen confirm">
				<ScreenGrain />
			</div>
		);
	}
	return (
		<Editor
			key={generation}
			intent={data}
			notice={notice}
			onStale={() => {
				setNotice(VERSION_CONFLICT_MESSAGE);
				void refetch().then(() => setGeneration((g) => g + 1));
			}}
		/>
	);
}
