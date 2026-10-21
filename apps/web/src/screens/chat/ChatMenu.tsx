/**
 * 操作メニュー(F6b設計 §1.6・F7c設計 §1.2・§1.8)。「このつながりについて」のシートで・
 * 参加の取り消しと表示から消すを・同じシートの中の1段の確認(元には戻せません)を経て行う。
 * 通報は通報画面へ移り・ブロックは同じシートの確認(グループは先に相手を選ぶ)を経て行う。
 * prototype/project/ChatMenu.dc.html・Block.dc.html(app.jsのscreens.block)の移植。
 * 通報・ブロックの行は状態を問わず出し・できるかはAPIが判定する(相手の候補はmembersのまま)
 */

import type { LatchDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useHideMutation, useLeaveMutation } from "../../chat/queries";
import { latchQueryKey } from "../../latches/queries";
import { reportPath } from "../../routes/paths";
import { safetyErrorText, useBlock } from "../../safety/queries";

type ChatMenuProps = {
	latch: LatchDTO;
	onClose(): void;
	/** 参加の取り消しが成功した(応答は操作後のLATCH) */
	onLeft(result: LatchDTO): void;
	/** 表示から消すが成功した */
	onHidden(): void;
	/** ブロックが成功した。left=本人がこのLATCHから抜けた(以後このLATCHは読めない) */
	onBlocked(left: boolean): void;
};

type Step =
	| "menu"
	| "confirm-leave"
	| "confirm-hide"
	| "pick-block"
	| "confirm-block";

const ICON_EXIT =
	"M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M15 8l4 4-4 4M19 12H9.5";
const ICON_UNDO = "M9 7L4.5 11.5 9 16M5 11.5h9a5 5 0 0 1 0 10h-2";
const ICON_FLAG = "M6 20.5V4.5M6 5h11.2l-2.2 4 2.2 4H6";
const ICON_CHEV = "M9.5 6l6 6-6 6";
const ICON_CHECK = "M5 12.5l4.6 4.6L19 7.6";

function Icon({ d, className = "ic" }: { d: string; className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden="true">
			<path d={d} />
		</svg>
	);
}

function BlockIcon() {
	return (
		<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
			<circle cx="12" cy="12" r="8.5" />
			<path d="M6 18L18 6" />
		</svg>
	);
}

export function ChatMenu({
	latch,
	onClose,
	onLeft,
	onHidden,
	onBlocked,
}: ChatMenuProps) {
	const client = useQueryClient();
	const leave = useLeaveMutation(latch.id);
	const hide = useHideMutation(latch.id);
	const continuing = latch.status === "matched";
	const group = latch.participants_count > 2;
	// 続いているグループのブロックは本人が抜ける(以後このLATCHは読めない)。
	// 終了後(completed・matched経由のcancelled)のブロックはLATCHを変えない(08 §8)
	const leavesLatch = continuing && group;
	const block = useBlock(latch.id, { leavesLatch });
	const [step, setStep] = useState<Step>("menu");
	const [failed, setFailed] = useState(false);
	/** ブロックする相手(1対1は唯一の相手・グループは選んだ人) */
	const [blockee, setBlockee] = useState<string | null>(null);
	const [blockError, setBlockError] = useState<string | null>(null);
	const busy = leave.isPending || hide.isPending || block.isPending;
	const members = latch.members ?? [];
	const blockeeName =
		members.find((m) => m.user_id === blockee)?.display_name ?? "";

	const leaveSub = group
		? "このつながりから抜けます。"
		: "このつながりを終えます。チャットはお互いに読み取り専用になります。";
	const hideSub = continuing
		? group
			? "このつながりから抜けて、自分の一覧から消します。相手の側には履歴が残ります。"
			: "このつながりを終えて、自分の一覧から消します。相手の側には履歴が残ります。"
		: "自分の一覧から消します。相手の側には残ります。";

	// 失敗(400・404・通信失敗)はLATCHを取り直して正しい表示にし・一文を出す
	const fail = () => {
		setFailed(true);
		setStep("menu");
		void client.invalidateQueries({ queryKey: latchQueryKey(latch.id) });
	};

	const doLeave = () => {
		if (busy) return;
		setFailed(false);
		leave.mutate(undefined, { onSuccess: onLeft, onError: fail });
	};
	const doHide = () => {
		if (busy) return;
		setFailed(false);
		hide.mutate(undefined, { onSuccess: onHidden, onError: fail });
	};

	const startBlock = () => {
		setFailed(false);
		setBlockError(null);
		if (group) {
			setBlockee(null);
			setStep("pick-block");
		} else {
			setBlockee(members[0]?.user_id ?? null);
			setStep("confirm-block");
		}
	};
	const doBlock = () => {
		if (busy || blockee === null) return;
		setBlockError(null);
		block.mutate(blockee, {
			onSuccess: () => onBlocked(leavesLatch),
			onError: (error) => setBlockError(safetyErrorText(error)),
		});
	};

	return (
		<>
			{/* 送信中に閉じると成功後の遷移が走らないため・その間は背景で閉じない */}
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
				aria-label={
					step === "confirm-block" ? "ブロックの確認" : "このつながりについて"
				}
			>
				<div className="sheet">
					<span className="sheet__grab" aria-hidden="true" />
					{step === "menu" ? (
						<>
							<h2 className="sheet__title" style={{ fontSize: 19 }}>
								このつながりについて
							</h2>
							{failed ? (
								<p className="t-caption" role="alert">
									この操作は、いまはできません。
								</p>
							) : null}
							<div
								className="list"
								style={{ margin: "0 calc(var(--gutter) * -1)" }}
							>
								<Link className="list-row" to={reportPath(latch.id)}>
									<Icon d={ICON_FLAG} />
									<span>通報する</span>
									<Icon d={ICON_CHEV} className="ic list-row__chev" />
								</Link>
								{members.length > 0 ? (
									<button
										type="button"
										className="list-row"
										onClick={startBlock}
									>
										<BlockIcon />
										<span>ブロックする</span>
										<Icon d={ICON_CHEV} className="ic list-row__chev" />
									</button>
								) : null}
								{continuing ? (
									<button
										type="button"
										className="list-row"
										onClick={() => setStep("confirm-leave")}
									>
										<Icon d={ICON_EXIT} />
										<span className="stack">
											<span>参加を取り消す</span>
											<span className="list-row__sub">{leaveSub}</span>
										</span>
										<span />
									</button>
								) : null}
								<button
									type="button"
									className="list-row"
									onClick={() => setStep("confirm-hide")}
								>
									<Icon d={ICON_UNDO} />
									<span className="stack">
										<span>表示から消す</span>
										<span className="list-row__sub">{hideSub}</span>
									</span>
									<span />
								</button>
							</div>
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--quiet btn--block"
									onClick={onClose}
								>
									閉じる
								</button>
							</div>
						</>
					) : step === "pick-block" ? (
						<>
							<h2 className="sheet__title" style={{ fontSize: 19 }}>
								ブロックする相手を選んでください。
							</h2>
							<div>
								{members.map((m) => (
									<label className="radio-row" key={m.user_id}>
										<input
											type="radio"
											name="blockee"
											checked={blockee === m.user_id}
											onChange={() => setBlockee(m.user_id)}
										/>
										<span>{m.display_name}</span>
									</label>
								))}
							</div>
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--primary btn--block"
									disabled={blockee === null}
									onClick={() => setStep("confirm-block")}
								>
									次へ
								</button>
								<button
									type="button"
									className="btn btn--quiet btn--block"
									onClick={() => setStep("menu")}
								>
									やめる
								</button>
							</div>
						</>
					) : step === "confirm-block" ? (
						<>
							<h2 className="sheet__title">
								{blockeeName}さんを、ブロックしますか。
							</h2>
							<ul className="bullets">
								{/* 1対1は全体が終わり読み取り専用・続いているグループは本人が抜ける(読めなくなる)・
								    終了後のグループは何も変わらないので出さない */}
								{!group || continuing ? (
									<li>
										<Icon d={ICON_CHECK} />
										<span>
											{group
												? "このグループから抜けます。"
												: "このつながりのチャットは、読み取り専用になります。"}
										</span>
									</li>
								) : null}
								<li>
									<Icon d={ICON_CHECK} />
									<span>今後、この相手との提案は届きません。</span>
								</li>
								<li>
									<Icon d={ICON_CHECK} />
									<span>ブロックしたことは、相手に通知されません。</span>
								</li>
							</ul>
							{/* 続いているグループは抜けた後に開けず通報できなくなるため、ブロックの前に
							    通報へ進める入口を置く(01 D-10)。相手はURLに出さず遷移の付帯情報で渡す */}
							{blockee !== null && !busy ? (
								<div
									className="list"
									style={{ margin: "16px calc(var(--gutter) * -1) 0" }}
								>
									<Link
										className="list-row"
										to={reportPath(latch.id)}
										state={{ reporteeId: blockee }}
									>
										<Icon d={ICON_FLAG} />
										<span>ブロックの前に通報する</span>
										<Icon d={ICON_CHEV} className="ic list-row__chev" />
									</Link>
								</div>
							) : null}
							{blockError !== null ? (
								<p className="note" role="alert" style={{ marginTop: 16 }}>
									{blockError}
								</p>
							) : null}
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--danger btn--block"
									disabled={busy}
									onClick={doBlock}
								>
									ブロックする
								</button>
								<button
									type="button"
									className="btn btn--quiet btn--block"
									disabled={busy}
									onClick={() => setStep("menu")}
								>
									やめる
								</button>
							</div>
						</>
					) : (
						<>
							<h2 className="sheet__title" style={{ fontSize: 19 }}>
								{step === "confirm-leave"
									? "参加を取り消しますか。元には戻せません。"
									: "表示から消しますか。元には戻せません。"}
							</h2>
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--primary btn--block"
									disabled={busy}
									onClick={step === "confirm-leave" ? doLeave : doHide}
								>
									{step === "confirm-leave" ? "取り消す" : "消す"}
								</button>
								<button
									type="button"
									className="btn btn--quiet btn--block"
									disabled={busy}
									onClick={() => setStep("menu")}
								>
									やめる
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</>
	);
}
