import { DurableObject } from "cloudflare:workers";
import {
	type ChatErrorCode,
	type ChatServerFrame,
	chatClientFrameSchema,
	clientIdSchema,
	messageBodySchema,
} from "@latch/shared";
import { drizzle } from "drizzle-orm/d1";
import { monotonicFactory } from "ulid";
import {
	activeMemberIds,
	type SendResult,
	type StoredMessage,
	sendMessage,
	toMessageDto,
} from "../chat/messages";
import { systemClock } from "../clock/clock";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";

const logger = createLogger();

/** 休止をまたいで接続に残す情報(F6a設計 §1.1) */
interface Attachment {
	userId: string;
	latchId: string;
	/** 接続を受け入れた時刻(エポックミリ秒)。切断の記録の保持時間に使う(#46) */
	acceptedAt?: number;
}

/** 内部要求の文字列項目(空でない文字列) */
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 内部/sendの要求(bodyはルートでtrim済み)。形が違えばnull */
const parseSendRequest = (
	raw: unknown,
): {
	userId: string;
	latchId: string;
	body: string;
	clientId: string;
} | null => {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const body = messageBodySchema.safeParse(r.body);
	const clientId = clientIdSchema.safeParse(r.client_id);
	if (!isId(r.latch_id) || !isId(r.user_id)) return null;
	if (!body.success || !clientId.success) return null;
	return {
		latchId: r.latch_id,
		userId: r.user_id,
		body: body.data,
		clientId: clientId.data,
	};
};

/** 内部/closedの要求。user_ids=nullは全接続。形が違えばundefined */
const parseClosedUserIds = (raw: unknown): string[] | null | undefined => {
	if (typeof raw !== "object" || raw === null) return undefined;
	const ids = (raw as Record<string, unknown>).user_ids;
	if (ids === null) return null;
	if (Array.isArray(ids) && ids.every(isId)) return ids;
	return undefined;
};

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const frame = (f: ChatServerFrame): string => JSON.stringify(f);

/**
 * チャットルームのDurable Object(成立LATCHごとに1DO・F6a設計 §1・docs/04 §4)。
 * メッセージの正はD1で、DOは接続の受け入れ(Hibernation API)・送信の直列処理と配信・
 * closedの配信と切断・チケットの使用済み記録を担う。Workerのルートからのみhttps://chat-do
 * の内部要求(/connect・/send・/closed)で到達する。例外は外へ出さない(F6a設計 §4)
 */
export class ChatRoomDO extends DurableObject<Env> {
	/** 単調増加のULID。IDの順=保存の順=配信の順(F6a設計 §1.2) */
	private readonly nextId = monotonicFactory();
	/** 送信を1件ずつ処理するための鎖(WebSocket・/sendとも同じ鎖に並ぶ) */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// ping→pongはDOを起こさずに自動応答する(F6a設計 §1.1)
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
		// チケットの1回限りの記録(F6a設計 §3.5)。DOに残す永続データはこれだけ
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS used_tickets (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)",
		);
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/connect" && request.method === "GET") {
				return this.acceptConnection(request);
			}
			if (pathname === "/send" && request.method === "POST") {
				return await this.handleSendRequest(request);
			}
			if (pathname === "/closed" && request.method === "POST") {
				return await this.handleClosedRequest(request);
			}
			return json(404, { reason: "not_found" });
		} catch {
			logger.error("chat.do_request_failed", { error_code: "internal" });
			return json(500, { reason: "internal" });
		}
	}

	/** 接続の受け入れ(F6a設計 §1.1の3〜4)。ルートでチケットと参加は検証済み */
	private acceptConnection(request: Request): Response {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return json(426, { reason: "upgrade_required" });
		}
		const latchId = request.headers.get("x-latch-id");
		const userId = request.headers.get("x-user-id");
		const jti = request.headers.get("x-ticket-jti");
		const expRaw = request.headers.get("x-ticket-exp");
		const exp = Number(expRaw);
		if (!latchId || !userId || !jti || !expRaw || !Number.isInteger(exp)) {
			return json(401, { reason: "unauthorized" });
		}
		const nowSec = Math.floor(systemClock.now().getTime() / 1000);
		const sql = this.ctx.storage.sql;
		// 期限の過ぎたjtiは記録のたびに掃除する
		sql.exec("DELETE FROM used_tickets WHERE exp < ?", nowSec);
		const written = sql.exec(
			"INSERT INTO used_tickets (jti, exp) VALUES (?, ?) ON CONFLICT DO NOTHING",
			jti,
			exp,
		).rowsWritten;
		if (written === 0) return json(401, { reason: "unauthorized" });

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [userId]);
		server.serializeAttachment({
			userId,
			latchId,
			acceptedAt: systemClock.now().getTime(),
		} satisfies Attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** RESTの送信の転送(F6a設計 §1.2)。応答のmessageは送信者視点 */
	private async handleSendRequest(request: Request): Promise<Response> {
		const req = parseSendRequest(await request.json());
		if (req === null) return json(400, { reason: "invalid_message" });
		const result = await this.serial(() =>
			this.sendAndBroadcast(req.latchId, req.userId, req.body, req.clientId),
		);
		if (result.ok) {
			return json(201, { message: toMessageDto(result.message, req.userId) });
		}
		if (result.reason === "not_found")
			return json(404, { reason: "not_found" });
		return json(400, { reason: result.reason });
	}

	/** つないでいる人へのclosedの知らせ(F6a設計 §2.4) */
	private async handleClosedRequest(request: Request): Promise<Response> {
		const user_ids = parseClosedUserIds(await request.json());
		if (user_ids === undefined) return json(400, { reason: "invalid_request" });
		const targets =
			user_ids === null
				? this.ctx.getWebSockets()
				: user_ids.flatMap((u) => this.ctx.getWebSockets(u));
		for (const ws of targets) this.sendClosed(ws);
		return new Response(null, { status: 204 });
	}

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		// フレームの検証は鎖に並べる前に同期で行い、受信順のまま鎖へ積む
		if (typeof message !== "string") {
			this.sendError(ws, "invalid_message", null);
			return;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(message);
		} catch {
			this.sendError(ws, "invalid_message", null);
			return;
		}
		const parsed = chatClientFrameSchema.safeParse(raw);
		if (!parsed.success) {
			this.sendError(ws, "invalid_message", readableClientId(raw));
			return;
		}
		const { body, client_id } = parsed.data;
		const attachment = ws.deserializeAttachment() as Attachment | null;
		if (attachment === null) {
			this.sendClosed(ws);
			return;
		}
		try {
			const result = await this.serial(() =>
				this.sendAndBroadcast(
					attachment.latchId,
					attachment.userId,
					body,
					client_id,
				),
			);
			if (result.ok) return;
			// 接続中に本人が抜けた等はclosedで閉じる(F6a設計 §3.4)
			if (result.reason === "not_found") this.sendClosed(ws);
			else this.sendError(ws, "read_only", client_id);
		} catch {
			logger.error("chat.send_failed", {
				latch_id: attachment.latchId,
				error_code: "internal",
			});
			this.sendError(ws, "internal", client_id);
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		// 状態はD1にあり、DOに残すものは無い。閉じるだけ(F6a設計 §4)
		logClosed(ws, code);
		closeQuietly(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		// エラーでは閉じたコードが分からない。1006(異常終了)として記録する
		logClosed(ws, 1006);
		closeQuietly(ws);
	}

	/** 送信の直列化。前の送信が終わってから次を始める(F6a設計 §1.2) */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * 送信の共通処理(WebSocket・/sendとも)。保存に成功したら現在の参加者を1回照会し、
	 * 含まれる接続へmessage、含まれない接続(closedの知らせが届かなかった離脱者等)へ
	 * closedを送って閉じる(F6a設計 §1.2)
	 */
	private async sendAndBroadcast(
		latchId: string,
		userId: string,
		body: string,
		clientId: string,
	): Promise<SendResult> {
		const db = drizzle(this.env.DB);
		const now = systemClock.now();
		const result = await sendMessage(db, {
			latchId,
			userId,
			body,
			clientId,
			id: this.nextId(now.getTime()),
			now,
		});
		if (!result.ok) return result;
		const active = new Set(await activeMemberIds(db, latchId));
		this.broadcast(result.message, active);
		return result;
	}

	private broadcast(message: StoredMessage, active: Set<string>): void {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (attachment === null || !active.has(attachment.userId)) {
				this.sendClosed(ws);
				continue;
			}
			sendQuietly(
				ws,
				frame({ type: "message", ...toMessageDto(message, attachment.userId) }),
			);
		}
	}

	private sendError(
		ws: WebSocket,
		code: ChatErrorCode,
		clientId: string | null,
	): void {
		sendQuietly(ws, frame({ type: "error", code, client_id: clientId }));
	}

	/** closedを送ってから接続を閉じる(F6a設計 §2.4・§3.4) */
	private sendClosed(ws: WebSocket): void {
		sendQuietly(ws, frame({ type: "closed" }));
		try {
			ws.close(1000, "closed");
		} catch {
			// 既に閉じている
		}
	}
}

/** スキーマ違反のフレームからclient_idが読めればそれ、読めなければnull */
const readableClientId = (raw: unknown): string | null => {
	if (typeof raw !== "object" || raw === null) return null;
	const parsed = clientIdSchema.safeParse(
		(raw as Record<string, unknown>).client_id,
	);
	return parsed.success ? parsed.data : null;
};

/** 閉じかけの接続への送信の失敗は無視する(状態はD1にある) */
const sendQuietly = (ws: WebSocket, data: string): void => {
	try {
		ws.send(data);
	} catch {
		// 既に閉じている
	}
};

/** 接続が閉じたことの記録(#46)。コードと保持時間とLATCHだけで、本文・表示名は出さない */
const logClosed = (ws: WebSocket, code: number): void => {
	try {
		const a = ws.deserializeAttachment() as Attachment | null;
		const fields: Record<string, string | number> = { close_code: code };
		if (a !== null) {
			fields.latch_id = a.latchId;
			if (typeof a.acceptedAt === "number") {
				fields.hold_ms = Math.max(
					0,
					systemClock.now().getTime() - a.acceptedAt,
				);
			}
		}
		logger.info("chat.ws.closed", fields);
	} catch {
		// 記録の失敗で閉じる処理を止めない
	}
};

const closeQuietly = (ws: WebSocket): void => {
	try {
		ws.close(1000, "closed");
	} catch {
		// 既に閉じている
	}
};
