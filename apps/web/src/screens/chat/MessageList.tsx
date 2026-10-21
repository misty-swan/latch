/**
 * チャットの履歴本文(F6b設計 §1.3)。日付区切り・自分/相手の吹き出し・
 * グループの送り主名・自分の未確定の吹き出し(送信中・失敗)。
 * prototype/app/app.jsのscreens.chatの移植。
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
};

export function MessageList({
	latch,
	meId,
	messages,
	now,
	pending,
	onRetry,
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
						<div className={`msg ${mine ? "msg--mine" : "msg--theirs"}`}>
							{!mine && group ? (
								<span className="msg__who">{senderName(latch, m.user_id)}</span>
							) : null}
							<p className="msg__bubble">{m.body}</p>
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
