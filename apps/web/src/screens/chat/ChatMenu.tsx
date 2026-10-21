/**
 * 操作メニュー(F6b設計 §1.6)。「このつながりについて」のシートで・参加の取り消しと
 * 表示から消すを・同じシートの中の1段の確認(元には戻せません)を経て行う。
 * prototype/project/ChatMenu.dc.html のうち通報・ブロックはF7で足す。
 */

import type { LatchDTO } from "@latch/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useHideMutation, useLeaveMutation } from "../../chat/queries";
import { latchQueryKey } from "../../latches/queries";

type ChatMenuProps = {
	latch: LatchDTO;
	onClose(): void;
	/** 参加の取り消しが成功した(応答は操作後のLATCH) */
	onLeft(result: LatchDTO): void;
	/** 表示から消すが成功した */
	onHidden(): void;
};

type Step = "menu" | "confirm-leave" | "confirm-hide";

const ICON_EXIT =
	"M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M15 8l4 4-4 4M19 12H9.5";
const ICON_UNDO = "M9 7L4.5 11.5 9 16M5 11.5h9a5 5 0 0 1 0 10h-2";

function Icon({ d }: { d: string }) {
	return (
		<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
			<path d={d} />
		</svg>
	);
}

export function ChatMenu({ latch, onClose, onLeft, onHidden }: ChatMenuProps) {
	const client = useQueryClient();
	const leave = useLeaveMutation(latch.id);
	const hide = useHideMutation(latch.id);
	const [step, setStep] = useState<Step>("menu");
	const [failed, setFailed] = useState(false);
	const busy = leave.isPending || hide.isPending;
	const continuing = latch.status === "matched";
	const group = latch.participants_count > 2;

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

	return (
		<>
			<div className="backdrop" aria-hidden="true" onClick={onClose} />
			<div
				className="sheet-layer"
				role="dialog"
				aria-modal="true"
				aria-label="このつながりについて"
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
