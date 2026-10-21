/**
 * 通報(/latches/:id/report・F7c設計 §1.7)。prototype/app/app.jsのscreens.reportの移植。
 * 対象の欄は入口で変わる: 提案段階=欄なし(proposal)・チャットの「…」=プロフィール/アイコン
 * (グループは相手も選ぶ)・発言(?message=&user=)=欄なしで発言を引用(message)。
 */

import type { ReportCreateRequest } from "@latch/shared";
import { useState } from "react";
import {
	Link,
	useLocation,
	useNavigate,
	useParams,
	useSearchParams,
} from "react-router";
import { useLatchQuery } from "../../latches/queries";
import { chatPath, latchPath } from "../../routes/paths";
import { safetyErrorText, useReport } from "../../safety/queries";
import { ScreenGrain } from "../shared";
import "./report.css";

type Reason = ReportCreateRequest["reason"];
type Target = "profile" | "icon";

const REASONS: ReadonlyArray<readonly [Reason, string]> = [
	["spam", "スパム・勧誘"],
	["harassment", "嫌がらせ"],
	["inappropriate", "不適切な内容"],
	["other", "その他"],
];

const TARGETS: ReadonlyArray<readonly [Target, string]> = [
	["profile", "プロフィール(表示名・ひとこと)"],
	["icon", "アイコン"],
];

export function Report() {
	const { id = "" } = useParams();
	const [search] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();
	const latchQuery = useLatchQuery(id);
	const report = useReport();

	const [target, setTarget] = useState<Target | null>(null);
	const [reportee, setReportee] = useState<string | null>(null);
	const [reason, setReason] = useState<Reason | null>(null);
	const [note, setNote] = useState("");
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const latch = latchQuery.data;
	const messageId = search.get("message");
	const messageUser = search.get("user");
	const isMessage = messageId !== null && messageUser !== null;
	const quote = (location.state as { quote?: unknown } | null)?.quote;
	const proposalStage =
		latch !== undefined &&
		(latch.status === "proposed" || latch.status === "partial_accept");
	const backTo = proposalStage ? latchPath(id) : chatPath(id);

	const members = latch?.members ?? [];
	const group = (latch?.participants_count ?? 0) > 2;
	const needTarget = !isMessage && !proposalStage;
	const soleMember = members.length === 1 ? members[0]?.user_id : undefined;
	const reporteeId = isMessage
		? messageUser
		: proposalStage
			? null
			: group
				? reportee
				: (soleMember ?? null);

	const ready =
		latch !== undefined &&
		reason !== null &&
		(!needTarget || (target !== null && reporteeId !== null));

	const submit = () => {
		if (!ready || report.isPending || reason === null) return;
		const trimmed = note.trim();
		const body: ReportCreateRequest = isMessage
			? {
					latch_id: id,
					target: "message",
					reason,
					message_id: messageId,
					reportee_user_id: messageUser,
				}
			: proposalStage
				? { latch_id: id, target: "proposal", reason }
				: {
						latch_id: id,
						target: target ?? "profile",
						reason,
						...(reporteeId !== null ? { reportee_user_id: reporteeId } : {}),
					};
		if (trimmed !== "") body.note = trimmed;
		setError(null);
		report.mutate(body, {
			onSuccess: () => setDone(true),
			onError: (e) => setError(safetyErrorText(e)),
		});
	};

	return (
		<div className="screen report">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="btn btn--quiet btn--small" to={backTo}>
						やめる
					</Link>
				</div>
				<div className="topbar__title">通報する</div>
				<div className="topbar__side topbar__side--end" />
			</header>
			{latch === undefined ? (
				<div className="screen__body pad" style={{ paddingTop: 8 }}>
					{latchQuery.isError ? (
						<p className="note" role="alert">
							{safetyErrorText(latchQuery.error)}
						</p>
					) : null}
				</div>
			) : done ? (
				<>
					<div
						className="screen__body pad"
						style={{ paddingTop: 8, paddingBottom: 24 }}
					>
						<p className="t-body" role="status">
							通報を受け付けました。
						</p>
					</div>
					<div className="screen__foot">
						<button
							className="btn btn--primary btn--block"
							type="button"
							onClick={() => navigate(backTo)}
						>
							閉じる
						</button>
					</div>
				</>
			) : (
				<>
					<div
						className="screen__body pad"
						style={{ paddingTop: 8, paddingBottom: 24 }}
					>
						<p className="t-body">
							通報したことは、相手には通知されません。運営が内容を確かめ、5営業日以内に対応します。
						</p>
						{isMessage && typeof quote === "string" ? (
							<blockquote className="report-quote t-body">{quote}</blockquote>
						) : null}
						{needTarget ? (
							<>
								<h2 className="t-label" style={{ marginTop: 26 }}>
									対象
								</h2>
								<div style={{ marginTop: 8 }}>
									{TARGETS.map(([value, label]) => (
										<label className="radio-row" key={value}>
											<input
												type="radio"
												name="target"
												checked={target === value}
												onChange={() => setTarget(value)}
											/>
											<span>{label}</span>
										</label>
									))}
								</div>
								{group ? (
									<>
										<h2 className="t-label" style={{ marginTop: 26 }}>
											相手
										</h2>
										<div style={{ marginTop: 8 }}>
											{members.map((m) => (
												<label className="radio-row" key={m.user_id}>
													<input
														type="radio"
														name="reportee"
														checked={reportee === m.user_id}
														onChange={() => setReportee(m.user_id)}
													/>
													<span>{m.display_name}</span>
												</label>
											))}
										</div>
									</>
								) : null}
							</>
						) : null}
						<h2 className="t-label" style={{ marginTop: 26 }}>
							理由
						</h2>
						<div style={{ marginTop: 8 }}>
							{REASONS.map(([value, label]) => (
								<label className="radio-row" key={value}>
									<input
										type="radio"
										name="why"
										checked={reason === value}
										onChange={() => setReason(value)}
									/>
									<span>{label}</span>
								</label>
							))}
						</div>
						<div className="field" style={{ marginTop: 26 }}>
							<label className="field__label" htmlFor="rp-more">
								くわしく
								<span
									style={{
										fontWeight: 400,
										color: "var(--ink-3)",
										marginLeft: 6,
									}}
								>
									任意
								</span>
							</label>
							<textarea
								className="input"
								id="rp-more"
								rows={3}
								maxLength={500}
								value={note}
								onChange={(e) => setNote(e.target.value)}
							/>
						</div>
						{error !== null ? (
							<p className="note" role="alert" style={{ marginTop: 16 }}>
								{error}
							</p>
						) : null}
					</div>
					<div className="screen__foot">
						<button
							className="btn btn--primary btn--block"
							type="button"
							disabled={!ready || report.isPending}
							onClick={submit}
						>
							通報する
						</button>
					</div>
				</>
			)}
		</div>
	);
}
