/**
 * チャットの履歴本文(F6b設計 §1.3)。日付区切り・自分/相手の吹き出し・
 * グループの送り主名・自分の未確定の吹き出し(送信中・失敗)。
 * prototype/app/app.jsのscreens.chatの移植。
 * 相手の発言にだけ発言の操作(横のボタン・長押しのcontextmenu)を付ける(F7c設計 §1.2)。
 * 自分の発言・送信中/失敗の吹き出しには付けない(自分の発言は通報の対象にならない)
 */

import type { LatchDTO, MessageDTO } from "@latch/shared";
import { Fragment } from "react";
import { formatDayLabel, isSameJstDay, senderName } from "../../chat/format";
import { formatHm } from "../../latches/format";

/** 自分の未確定の吹き出し(Task 6の送信が渡す) */
export type PendingMessage = {
	clientId: string;
	body: string;
	state: "sending" | "failed";
};

type Props = {
	latch: LatchDTO;
	meId: string;
	messages: MessageDTO[];
	now: Date;
	pending: PendingMessage[];
	onRetry(clientId: string): void;
	/** 相手の発言の操作を開く */
	onMessageMenu(message: MessageDTO): void;
};

export function MessageList({
	latch,
	meId,
	messages,
	now,
	pending,
	onRetry,
	onMessageMenu,
}: Props) {
	const group = latch.participants_count > 2;
	return (
		<>
			{messages.map((m, i) => {
				const prev = messages[i - 1];
				const showDay = !prev || !isSameJstDay(prev.created_at, m.created_at);
				const mine = m.user_id === meId;
				return (
					<Fragment key={m.id}>
						{showDay ? (
							<p className="chat__day t-meta">
								{formatDayLabel(m.created_at, now)}
							</p>
						) : null}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: 長押しの近道。キーボード・読み上げでは横の「このメッセージの操作」ボタンで同じ操作ができる */}
						<div
							className={`msg ${mine ? "msg--mine" : "msg--theirs"}`}
							onContextMenu={
								mine
									? undefined
									: (e) => {
											e.preventDefault();
											onMessageMenu(m);
										}
							}
						>
							{!mine && group ? (
								<span className="msg__who">{senderName(latch, m.user_id)}</span>
							) : null}
							{mine ? (
								<p className="msg__bubble">{m.body}</p>
							) : (
								<div className="msg__line">
									<p className="msg__bubble">{m.body}</p>
									<button
										type="button"
										className="msg__more"
										aria-label="このメッセージの操作"
										onClick={() => onMessageMenu(m)}
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
								</div>
							)}
							<span className="msg__time">
								{formatHm(new Date(m.created_at).getTime())}
							</span>
						</div>
					</Fragment>
				);
			})}
			{pending.map((p) => (
				<div
					key={p.clientId}
					className={`msg msg--mine${p.state === "failed" ? " is-failed" : " is-sending"}`}
				>
					<p className="msg__bubble">{p.body}</p>
					{p.state === "failed" ? (
						<span className="msg__fail">
							<svg className="ic ic--xs" viewBox="0 0 24 24" aria-hidden="true">
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
							送信できませんでした
							<button
								className="btn btn--quiet btn--small"
								type="button"
								style={{
									minHeight: 44,
									padding: "0 10px",
									color: "inherit",
									textDecoration: "underline",
								}}
								onClick={() => onRetry(p.clientId)}
							>
								もう一度送る
							</button>
						</span>
					) : null}
				</div>
			))}
			{messages.length === 0 && pending.length === 0 ? (
				<p className="chat__hint t-caption">
					最初のひとことは、短くて大丈夫です。
				</p>
			) : null}
		</>
	);
}
