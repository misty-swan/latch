/**
 * 見送った画面と理由シート(表示のみ・prototype/app/app.js screens.shelved・
 * Shelved.dc.html・ShelvedOccasion.dc.html・DeferReason.dc.html)。
 * 理由の保存は親(onSaveReason)が担い・理由は1回だけ保存できる。
 */

import type { DeferReason, IntentForm } from "@latch/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
	markDeferNoteSeen,
	shouldShowDeferNote,
} from "../../latches/deferNote";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import { DomeRest, Tategaki } from "./art";

const REASONS: { value: DeferReason; label: string }[] = [
	{ value: "no_capacity", label: "いまは余裕がない" },
	{ value: "schedule_mismatch", label: "日時や場所が合わない" },
	{ value: "just_not_now", label: "なんとなく、今回は" },
	{ value: "other", label: "その他" },
];

/** トーストを出しておく時間(prototype toast()) */
const TOAST_MS = 2400;

type ShelvedProps = {
	form: IntentForm;
	onSaveReason(reason: DeferReason): Promise<void>;
};

export function Shelved({ form, onSaveReason }: ShelvedProps) {
	// 説明は初回描画で1度だけ判定する(記録後の再描画で消さない)
	const [showNote] = useState(() => shouldShowDeferNote(form));
	useEffect(() => {
		if (showNote) markDeferNoteSeen(form);
	}, [showNote, form]);

	const [sheet, setSheet] = useState(false);
	const [reason, setReason] = useState<DeferReason | null>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [toast, setToast] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(false), TOAST_MS);
		return () => clearTimeout(t);
	}, [toast]);

	const save = async () => {
		if (reason === null || busy) return;
		setBusy(true);
		setFailed(false);
		try {
			await onSaveReason(reason);
			setSaved(true);
			setSheet(false);
			setToast(true);
		} catch {
			// 保存に失敗したらシートを開いたまま知らせ・選び直さず再送できるようにする
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="screen shelved">
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
			<div className="screen__body">
				<div style={{ position: "relative", height: 350 }}>
					<DomeRest
						size={150}
						style={{ position: "absolute", left: 40, top: 178 }}
					/>
					<Tategaki
						text={"そっと、\n棚に戻しました。"}
						className="reveal"
						style={{
							position: "absolute",
							right: 34,
							top: 40,
							fontSize: 26,
						}}
					/>
				</div>
				<div className="pad">
					<p className="t-body rise rise-3" style={{ color: "var(--ink)" }}>
						今回の提案は見送りました。あなたの意思は、そのまま預けています。
					</p>
					{showNote ? (
						<div className="rise rise-4">
							<p className="note" style={{ marginTop: 22 }}>
								<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
									<circle cx="12" cy="12" r="8.5" />
									<path d="M12 11v5.2" />
									<circle
										cx="12"
										cy="7.9"
										r=".9"
										fill="currentColor"
										stroke="none"
									/>
								</svg>
								<span>
									{form === "occasion"
										? "条件が変われば、また届くことがあります。"
										: "この相手との提案は今後届きません。"}
								</span>
							</p>
						</div>
					) : null}
				</div>
			</div>
			<div className="screen__foot">
				<Link className="btn btn--primary btn--block" to={PATHS.home}>
					閉じる
				</Link>
				{!saved ? (
					<button
						className="btn btn--quiet"
						type="button"
						onClick={() => setSheet(true)}
					>
						見送った理由を残す(任意)
					</button>
				) : null}
			</div>
			{toast ? (
				<p className="toast" role="status">
					ありがとうございます。相手には伝わりません。
				</p>
			) : null}
			{sheet ? (
				<>
					<div
						className="backdrop"
						aria-hidden="true"
						onClick={() => setSheet(false)}
					/>
					<div
						className="sheet-layer"
						role="dialog"
						aria-modal="true"
						aria-label="見送った理由"
					>
						<div className="sheet">
							<span className="sheet__grab" aria-hidden="true" />
							<h2 className="sheet__title">
								見送った理由
								<span
									className="t-caption"
									style={{ fontFamily: "var(--f-gothic)", marginLeft: 8 }}
								>
									任意
								</span>
							</h2>
							<p className="t-caption" style={{ marginTop: -8 }}>
								相手には伝わりません。これからの提案の参考にします。
							</p>
							<div>
								{REASONS.map((r) => (
									<label className="radio-row" key={r.value}>
										<input
											type="radio"
											name="reason"
											value={r.value}
											checked={reason === r.value}
											onChange={() => setReason(r.value)}
										/>
										<span>{r.label}</span>
									</label>
								))}
							</div>
							{failed ? (
								<p className="t-caption" role="alert">
									送れませんでした。もう一度お試しください。
								</p>
							) : null}
							<div className="sheet__actions">
								<button
									className="btn btn--primary btn--block"
									type="button"
									disabled={reason === null || busy}
									onClick={() => void save()}
								>
									残す
								</button>
								<button
									className="btn btn--quiet btn--block"
									type="button"
									onClick={() => setSheet(false)}
								>
									スキップ
								</button>
							</div>
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
