/**
 * チャットAPIルート(F6a設計 §1.1・§2.2・§3.1・§3.4・docs/05 §3.2)。
 * - POST /v1/ws-ticket: WebSocket接続チケットの発行(60秒・1回限り)
 * - GET/POST /v1/latches/{id}/messages: 履歴取得・REST送信(保存と配信はChatRoomDOが直列に行う)
 * - POST /v1/latches/{id}/read: 既読位置の更新
 * - GET /v1/latches/{id}/ws: WebSocket接続(認証はチケット・Authorizationヘッダは使わない)
 * 失敗の写像: 非参加・存在しない・保留中・離脱/非表示=一律404 / それ以外=400 VALIDATION_FAILED
 * (details.reasons=[理由コード]) / WebSocketの認証失敗=401(理由を区別しない)・Upgradeでない=426。
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockを使う
 */

import {
	markReadRequestSchema,
	messageBodySchema,
	sendMessageRequestSchema,
	wsTicketRequestSchema,
} from "@latch/shared";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import {
	chatAccess,
	listMessages,
	markRead,
	toMessageDto,
} from "../chat/messages";
import { CHAT_DO_ORIGIN, chatRoomStub, forwardSend } from "../chat/notify";
import { issueChatTicket, verifyChatTicket } from "../chat/ticket";
import { systemClock } from "../clock/clock";
import { type Env, jwtSecret } from "../env";
import { errorJson } from "../http/errors";

/** チャットAPIのサブアプリ。index.tsが /v1 にマウントする(/v1/latches より前) */
export const chatRoutes = new Hono<AppEnv>();

const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** JSONボディを読む。空ボディは{}・JSON不正はundefined(400扱い)(latches.tsと同一のhelper) */
const readJsonBody = async (c: Context<AppEnv>): Promise<unknown> => {
	try {
		const text = await c.req.text();
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return undefined;
	}
};

const validationFailed = () =>
	errorJson("VALIDATION_FAILED", "リクエストが不正です");

/** 404。参加しない・存在しない・保留中・離脱/非表示は区別しない(docs/05 §3.1) */
const notFound = () => errorJson("NOT_FOUND", "LATCHが見つかりません");

/** 400。理由コードをdetails.reasonsに入れる */
const rejected = (reason: string) =>
	errorJson("VALIDATION_FAILED", "この操作はできません", {
		reasons: [reason],
	});

/** requireRegisteredが保証するため到達しない防御応答 */
const unauthorized = () =>
	errorJson(
		"UNAUTHORIZED",
		"この操作には登録済みユーザーのアクセストークンが必要です",
	);

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

chatRoutes.post("/ws-ticket", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const parsed = wsTicketRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const latchId = parsed.data.latch_id;
	const access = await chatAccess(dbOf(c.env), latchId, sub);
	if (access.kind === "not_found") {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	if (access.kind === "invalid_status") {
		const r = rejected("invalid_status");
		return c.json(r.body, r.status);
	}
	// 読み取り専用(completed等)にはWebSocketを開かせない
	if (!access.writable) {
		const r = rejected("read_only");
		return c.json(r.body, r.status);
	}
	const { ticket, expiresIn } = await issueChatTicket(
		jwtSecret(c.env),
		systemClock,
		{ userId: sub, latchId },
	);
	return c.json({ ticket, expires_in: expiresIn }, 200);
});

chatRoutes.get("/latches/:id/messages", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const before = c.req.query("before");
	if (before !== undefined && !ULID_PATTERN.test(before)) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const latchId = c.req.param("id");
	const access = await chatAccess(db, latchId, sub);
	if (access.kind === "not_found") {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	if (access.kind === "invalid_status") {
		const r = rejected("invalid_status");
		return c.json(r.body, r.status);
	}
	const page = await listMessages(db, latchId, before ?? null);
	return c.json(
		{
			items: page.items.map((m) => toMessageDto(m, sub)),
			next_before: page.nextBefore,
		},
		200,
	);
});

chatRoutes.post("/latches/:id/messages", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const raw = await readJsonBody(c);
	const parsed = sendMessageRequestSchema.safeParse(raw);
	if (!parsed.success) {
		// 本文だけが不正な場合は理由コードinvalid_message、その他の形の不正は理由なし
		const bodyField =
			typeof raw === "object" && raw !== null && "body" in raw
				? (raw as { body: unknown }).body
				: undefined;
		const bodyInvalid = !messageBodySchema.safeParse(bodyField).success;
		const onlyBodyInvalid =
			bodyInvalid && parsed.error.issues.every((i) => i.path[0] === "body");
		const r = onlyBodyInvalid
			? rejected("invalid_message")
			: validationFailed();
		return c.json(r.body, r.status);
	}
	const result = await forwardSend(c.env, {
		latchId: c.req.param("id"),
		userId: sub,
		body: parsed.data.body,
		clientId: parsed.data.client_id,
	});
	if (!result.ok) {
		const r =
			result.reason === "not_found" ? notFound() : rejected(result.reason);
		return c.json(r.body, r.status);
	}
	return c.json(result.message, 201);
});

chatRoutes.post("/latches/:id/read", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const parsed = markReadRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const latchId = c.req.param("id");
	const access = await chatAccess(db, latchId, sub);
	if (access.kind === "not_found") {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	if (access.kind === "invalid_status") {
		const r = rejected("invalid_status");
		return c.json(r.body, r.status);
	}
	const result = await markRead(
		db,
		latchId,
		sub,
		parsed.data.last_read_message_id,
	);
	if (!result.ok) {
		const r = rejected(result.reason);
		return c.json(r.body, r.status);
	}
	return c.body(null, 204);
});

/**
 * WebSocket接続(F6a設計 §3.4)。認証はクエリのチケット。検証・LATCH一致・参加と書き込み可否を
 * 確認し、DOへは検証済みクレームから組み立てた新しいリクエストで委譲する
 * (クライアントのヘッダはDOへ渡さない=x-user-idの偽装を防ぐ)
 */
chatRoutes.get("/latches/:id/ws", async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		const r = errorJson("UPGRADE_REQUIRED", "WebSocketで接続してください");
		return c.json(r.body, r.status);
	}
	const fail = () => {
		const r = errorJson("UNAUTHORIZED", "接続を認証できません");
		return c.json(r.body, r.status);
	};
	const latchId = c.req.param("id");
	const claims = await verifyChatTicket(
		jwtSecret(c.env),
		c.req.query("ticket") ?? "",
	);
	if (claims === null || claims.latchId !== latchId) {
		return fail();
	}
	const access = await chatAccess(dbOf(c.env), latchId, claims.userId);
	if (access.kind !== "readable" || !access.writable) {
		return fail();
	}
	return chatRoomStub(c.env, latchId).fetch(
		new Request(`${CHAT_DO_ORIGIN}/connect`, {
			headers: {
				Upgrade: "websocket",
				"x-latch-id": latchId,
				"x-user-id": claims.userId,
				"x-ticket-jti": claims.jti,
				"x-ticket-exp": String(claims.exp),
			},
		}),
	);
});
