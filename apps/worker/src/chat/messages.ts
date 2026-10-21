/**
 * チャットメッセージのD1操作(F6a設計 §2.1・§2.2)。メッセージの正はD1で、Durable Objectsは
 * 配信だけを担う(docs/04 §4)。ここは時刻・IDを引数で受け取る純粋なD1操作で、本文の検証は
 * 呼び出し側(zodのtrim().min(1).max(2000))が済ませた値を受け取る
 */

import { CHAT, type MessageDTO } from "@latch/shared";
import { and, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	latches,
	latchMembers,
	latchStatusEvents,
	messages,
} from "../db/schema";

export interface StoredMessage {
	id: string;
	latchId: string;
	userId: string;
	body: string;
	createdAt: Date;
	clientId: string | null;
}

export type ChatAccess =
	| { kind: "not_found" }
	| { kind: "invalid_status" }
	| { kind: "readable"; writable: boolean };

/**
 * 本人から見たチャットの可否(F6a設計 §2.2の表)。非参加・離脱・非表示・保留中・不在は
 * not_found、成立前や成立せずに閉じたものはinvalid_status、completedと
 * matched経由のcancelledは読み取り専用
 */
export const chatAccess = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
): Promise<ChatAccess> => {
	const [row] = await db
		.select({
			status: latches.status,
			leftAt: latchMembers.leftAt,
			hiddenAt: latchMembers.hiddenAt,
		})
		.from(latches)
		.innerJoin(
			latchMembers,
			and(
				eq(latchMembers.latchId, latches.id),
				eq(latchMembers.userId, userId),
			),
		)
		.where(eq(latches.id, latchId));
	if (row === undefined || row.leftAt !== null || row.hiddenAt !== null) {
		return { kind: "not_found" };
	}
	switch (row.status) {
		case "candidate":
			return { kind: "not_found" };
		case "matched":
			return { kind: "readable", writable: true };
		case "completed":
			return { kind: "readable", writable: false };
		case "cancelled": {
			// matchedを経たcancelledだけ読める(loadLatchDtoと同じ判定・docs/05 §3.3)
			const [event] = await db
				.select({ id: latchStatusEvents.id })
				.from(latchStatusEvents)
				.where(
					and(
						eq(latchStatusEvents.latchId, latchId),
						eq(latchStatusEvents.toStatus, "matched"),
					),
				)
				.limit(1);
			return event === undefined
				? { kind: "invalid_status" }
				: { kind: "readable", writable: false };
		}
		default:
			return { kind: "invalid_status" };
	}
};

export type SendResult =
	| { ok: true; message: StoredMessage }
	| { ok: false; reason: "not_found" | "invalid_status" | "read_only" };

/**
 * 送信の条件付き保存(F6a設計 §2.1)。LATCHがmatchedかつ本人が参加中(left_at・hidden_atなし)
 * という条件を保存のINSERT文の中で評価し、同じバッチでlast_message_atを進める(挿入が
 * 起きたときだけ)。挿入されなかったときは再送の冪等→参加者でない→読み取り専用の順で判定する
 */
export const sendMessage = async (
	db: DrizzleD1Database,
	input: {
		latchId: string;
		userId: string;
		body: string;
		clientId: string;
		id: string;
		now: Date;
	},
): Promise<SendResult> => {
	const { latchId, userId, body, clientId, id, now } = input;
	const nowMs = now.getTime();
	const insert = db
		.insert(messages)
		.select(
			sql`SELECT ${id}, ${latchId}, ${userId}, ${body}, ${nowMs}, ${clientId}
				WHERE EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status = 'matched')
				AND EXISTS (SELECT 1 FROM latch_members WHERE latch_id = ${latchId} AND user_id = ${userId} AND left_at IS NULL AND hidden_at IS NULL)`,
		)
		.onConflictDoNothing();
	const touch = db
		.update(latches)
		.set({ lastMessageAt: now })
		.where(
			and(
				eq(latches.id, latchId),
				eq(latches.status, "matched"),
				sql`EXISTS (SELECT 1 FROM messages WHERE id = ${id})`,
			),
		);
	await db.batch([insert, touch]);
	const [saved] = await db.select().from(messages).where(eq(messages.id, id));
	if (saved !== undefined) return { ok: true, message: saved };
	// 同じclient_idの保存済み行があれば再送として成功を返す
	const [existing] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.latchId, latchId),
				eq(messages.userId, userId),
				eq(messages.clientId, clientId),
			),
		);
	if (existing !== undefined) return { ok: true, message: existing };
	const access = await chatAccess(db, latchId, userId);
	if (access.kind === "not_found") return { ok: false, reason: "not_found" };
	if (access.kind === "invalid_status") {
		return { ok: false, reason: "invalid_status" };
	}
	return { ok: false, reason: "read_only" };
};

/** 履歴1頁。id<beforeを新しい順に51件取り、50件をID昇順で返す(51件目があれば次頁あり) */
export const listMessages = async (
	db: DrizzleD1Database,
	latchId: string,
	before: string | null,
): Promise<{ items: StoredMessage[]; nextBefore: string | null }> => {
	const size = CHAT.MESSAGE_PAGE_SIZE;
	const rows = await db
		.select()
		.from(messages)
		.where(
			before === null
				? eq(messages.latchId, latchId)
				: and(eq(messages.latchId, latchId), lt(messages.id, before)),
		)
		.orderBy(desc(messages.id))
		.limit(size + 1);
	const hasMore = rows.length > size;
	const items = rows.slice(0, size).reverse();
	return { items, nextBefore: hasMore ? items[0].id : null };
};

/** 既読位置を進める。当該LATCHのメッセージでなければunknown_message。既存より前には戻さない */
export const markRead = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	messageId: string,
): Promise<{ ok: true } | { ok: false; reason: "unknown_message" }> => {
	const [target] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.latchId, latchId)));
	if (target === undefined) return { ok: false, reason: "unknown_message" };
	await db.run(sql`INSERT INTO chat_reads (latch_id, user_id, last_read_message_id)
		VALUES (${latchId}, ${userId}, ${messageId})
		ON CONFLICT(latch_id, user_id) DO UPDATE SET last_read_message_id =
			CASE WHEN excluded.last_read_message_id > chat_reads.last_read_message_id
				THEN excluded.last_read_message_id ELSE chat_reads.last_read_message_id END`);
	return { ok: true };
};

/** LatchDTO用の要約: 最新メッセージと、本人以外の未読件数(F6a設計 §3.2) */
export const chatSummary = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
): Promise<{
	lastMessage: { body: string; createdAt: Date; userId: string } | null;
	unreadCount: number;
}> => {
	const [last] = await db
		.select({
			body: messages.body,
			createdAt: messages.createdAt,
			userId: messages.userId,
		})
		.from(messages)
		.where(eq(messages.latchId, latchId))
		.orderBy(desc(messages.id))
		.limit(1);
	const [unread] = await db
		.select({ n: sql<number>`count(*)` })
		.from(messages)
		.where(
			and(
				eq(messages.latchId, latchId),
				ne(messages.userId, userId),
				sql`${messages.id} > COALESCE((SELECT last_read_message_id FROM chat_reads WHERE latch_id = ${latchId} AND user_id = ${userId}), '')`,
			),
		);
	return { lastMessage: last ?? null, unreadCount: Number(unread?.n ?? 0) };
};

/** 離脱もhiddenもしていない参加者のuser_id */
export const activeMemberIds = async (
	db: DrizzleD1Database,
	latchId: string,
): Promise<string[]> => {
	const rows = await db
		.select({ userId: latchMembers.userId })
		.from(latchMembers)
		.where(
			and(
				eq(latchMembers.latchId, latchId),
				isNull(latchMembers.leftAt),
				isNull(latchMembers.hiddenAt),
			),
		);
	return rows.map((r) => r.userId);
};

/** client_idは本人の送信にだけ値を入れ、他人の送信はnullにする */
export const toMessageDto = (
	m: StoredMessage,
	viewerId: string,
): MessageDTO => ({
	id: m.id,
	user_id: m.userId,
	body: m.body,
	created_at: m.createdAt.toISOString(),
	client_id: m.userId === viewerId ? m.clientId : null,
});
