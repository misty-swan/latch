/**
 * ルートからChatRoomDOへの内部呼び出し(F6a設計 §1・§2.4)。DOへはWorkerのルートからだけ
 * stub.fetchで到達する(ホストはhttps://chat-doで固定・外部からは到達できない)
 */
import type { MessageDTO } from "@latch/shared";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";

const logger = createLogger();

/** DOの内部要求のオリジン(実在のホストではなく、DOのfetchの宛先の印) */
export const CHAT_DO_ORIGIN = "https://chat-do";

/** LATCHごとに1つのチャットルームDO(idFromName(latch_id)) */
export const chatRoomStub = (env: Env, latchId: string): DurableObjectStub =>
	env.CHAT_DO.get(env.CHAT_DO.idFromName(latchId));

export type ForwardSendResult =
	| { ok: true; message: MessageDTO }
	| { ok: false; reason: "not_found" | "invalid_status" | "read_only" };

/**
 * RESTの送信をDOへ転送する(F6a設計 §1.2)。保存と配信はDOが直列に行い、送信者視点の
 * MessageDTOを返す。想定外の応答(500等)は例外にして既存の共通エラー応答へ渡す
 */
export const forwardSend = async (
	env: Env,
	input: { latchId: string; userId: string; body: string; clientId: string },
): Promise<ForwardSendResult> => {
	const res = await chatRoomStub(env, input.latchId).fetch(
		`${CHAT_DO_ORIGIN}/send`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				latch_id: input.latchId,
				user_id: input.userId,
				body: input.body,
				client_id: input.clientId,
			}),
		},
	);
	if (res.status === 201) {
		const { message } = (await res.json()) as { message: MessageDTO };
		return { ok: true, message };
	}
	if (res.status === 404) return { ok: false, reason: "not_found" };
	if (res.status === 400) {
		const { reason } = (await res.json()) as { reason?: string };
		if (reason === "invalid_status" || reason === "read_only") {
			return { ok: false, reason };
		}
	}
	throw new Error(`CHAT_DO_SEND_FAILED: status=${res.status}`);
};

/**
 * つないでいる人へclosedを知らせる(F6a設計 §2.4)。userIds=nullは全員、配列は該当者の接続だけ。
 * 知らせは最善努力で、失敗はログに記録して握りつぶす(正しい状態はD1にあり送信は条件で止まる)
 */
export const notifyClosed = async (
	env: Env,
	latchId: string,
	userIds: string[] | null,
): Promise<void> => {
	try {
		const res = await chatRoomStub(env, latchId).fetch(
			`${CHAT_DO_ORIGIN}/closed`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ latch_id: latchId, user_ids: userIds }),
			},
		);
		if (res.status !== 204) {
			logger.warn("chat.notify_closed_failed", { latch_id: latchId });
		}
	} catch {
		logger.warn("chat.notify_closed_failed", { latch_id: latchId });
	}
};
