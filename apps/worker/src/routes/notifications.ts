/**
 * アプリ内通知のAPIルート(F7b設計 §3)。
 * - GET /v1/notifications?cursor=: 本人の通知を新しい順(id降順)に20件。
 *   応答は{items, next_cursor, unread_count}。push_stateは返さない
 * - POST /v1/notifications/read {up_to_id}: 本人の未読のうちid≤up_to_idを既読にする。常に204(冪等)
 * - 本人が抜けた・表示から消したLATCHの通知と、対象が消えたintent_expiredは一覧・未読数から除く(05 §3.3)
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockを使う
 */

import {
	type NotificationDTO,
	notificationReadRequestSchema,
	PUSH_LIMITS,
} from "@latch/shared";
import {
	and,
	count,
	desc,
	eq,
	exists,
	inArray,
	isNull,
	lt,
	lte,
	or,
} from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import {
	intents,
	latches,
	latchMembers,
	notifications,
	users,
} from "../db/schema";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { DELETED_DISPLAY_NAME } from "../safety/block";

/** アプリ内通知のサブアプリ。index.tsが /v1/notifications にマウントする */
export const notificationRoutes = new Hono<AppEnv>();

const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** D1の1文あたりバインド上限(100)に収める1回の件数 */
const CHUNK = 48;

const chunks = <T>(items: T[]): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += CHUNK) {
		out.push(items.slice(i, i + CHUNK));
	}
	return out;
};

const unauthorized = () =>
	errorJson(
		"UNAUTHORIZED",
		"この操作には登録済みユーザーのアクセストークンが必要です",
	);

const validationFailed = () =>
	errorJson("VALIDATION_FAILED", "リクエストの形式が正しくありません");

/** 一覧cursorの不透明化(GET /v1/latchesと同方式・docs/05 §3.1) */
const encodeCursor = (id: string): string =>
	btoa(id).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const decodeCursor = (cursor: string): string | null => {
	let base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
	while (base64.length % 4 !== 0) {
		base64 += "=";
	}
	let decoded: string;
	try {
		decoded = atob(base64);
	} catch {
		return null;
	}
	return /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(decoded) ? decoded : null;
};

/**
 * 本人に見せてよい通知の条件(一覧と未読数で共通)。
 * system(未使用)は出さない。LATCH系は本人の参加行が離脱・表示削除されていないこと、
 * intent_expiredは対象Intentが残っていること
 */
const visibleTo = (db: DrizzleD1Database, userId: string) =>
	or(
		and(
			inArray(notifications.type, ["proposal", "matched", "closed"]),
			exists(
				db
					.select({ one: latchMembers.latchId })
					.from(latchMembers)
					.where(
						and(
							eq(latchMembers.latchId, notifications.latchId),
							eq(latchMembers.userId, userId),
							isNull(latchMembers.leftAt),
							isNull(latchMembers.hiddenAt),
						),
					),
			),
		),
		and(
			eq(notifications.type, "intent_expired"),
			exists(
				db
					.select({ one: intents.id })
					.from(intents)
					.where(eq(intents.id, notifications.intentId)),
			),
		),
	);

notificationRoutes.get("/", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	let cursorId: string | undefined;
	const cursorParam = c.req.query("cursor");
	if (cursorParam !== undefined) {
		const decoded = decodeCursor(cursorParam);
		if (decoded === null) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		cursorId = decoded;
	}
	const db = dbOf(c.env);
	const limit = PUSH_LIMITS.NOTIFICATIONS_PAGE_SIZE;
	const conditions = [eq(notifications.userId, sub), visibleTo(db, sub)];
	if (cursorId !== undefined) {
		conditions.push(lt(notifications.id, cursorId));
	}
	// 終端判定のためlimit+1件取得する(id降順)
	const rows = await db
		.select({
			id: notifications.id,
			type: notifications.type,
			latchId: notifications.latchId,
			intentId: notifications.intentId,
			readAt: notifications.readAt,
			createdAt: notifications.createdAt,
		})
		.from(notifications)
		.where(and(...conditions))
		.orderBy(desc(notifications.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	// 種別ごとの補助情報を頁単位でまとめて引く(行ごとの照会を避ける)
	const latchIdsOf = (types: string[]): string[] => [
		...new Set(
			page.flatMap((r) =>
				types.includes(r.type) && r.latchId !== null ? [r.latchId] : [],
			),
		),
	];
	const deadlines = new Map<string, Date>();
	for (const ids of chunks(latchIdsOf(["proposal"]))) {
		const found = await db
			.select({ id: latches.id, deadline: latches.responseDeadline })
			.from(latches)
			.where(inArray(latches.id, ids));
		for (const f of found) deadlines.set(f.id, f.deadline);
	}
	const namesByLatch = new Map<string, string[]>();
	for (const ids of chunks(latchIdsOf(["matched"]))) {
		const found = await db
			.select({
				latchId: latchMembers.latchId,
				userId: latchMembers.userId,
				displayName: users.displayName,
				status: users.status,
			})
			.from(latchMembers)
			.innerJoin(users, eq(users.id, latchMembers.userId))
			.where(inArray(latchMembers.latchId, ids));
		for (const f of found) {
			if (f.userId === sub) continue;
			const list = namesByLatch.get(f.latchId) ?? [];
			list.push(f.status === "deleted" ? DELETED_DISPLAY_NAME : f.displayName);
			namesByLatch.set(f.latchId, list);
		}
	}
	const rawTexts = new Map<string, string>();
	const intentIds = [
		...new Set(page.flatMap((r) => (r.intentId === null ? [] : [r.intentId]))),
	];
	for (const ids of chunks(intentIds)) {
		const found = await db
			.select({ id: intents.id, rawText: intents.rawText })
			.from(intents)
			.where(inArray(intents.id, ids));
		for (const f of found) rawTexts.set(f.id, f.rawText);
	}

	const items: NotificationDTO[] = [];
	for (const r of page) {
		const common = {
			id: r.id,
			read_at: r.readAt === null ? null : r.readAt.toISOString(),
			created_at: r.createdAt.toISOString(),
		};
		if (r.type === "proposal" && r.latchId !== null) {
			const deadline = deadlines.get(r.latchId);
			if (deadline === undefined) continue;
			items.push({
				...common,
				type: "proposal",
				latch_id: r.latchId,
				response_deadline: deadline.toISOString(),
			});
		} else if (r.type === "matched" && r.latchId !== null) {
			items.push({
				...common,
				type: "matched",
				latch_id: r.latchId,
				display_names: namesByLatch.get(r.latchId) ?? [],
			});
		} else if (r.type === "closed" && r.latchId !== null) {
			items.push({ ...common, type: "closed", latch_id: r.latchId });
		} else if (r.type === "intent_expired" && r.intentId !== null) {
			const rawText = rawTexts.get(r.intentId);
			if (rawText === undefined) continue;
			items.push({
				...common,
				type: "intent_expired",
				intent: { id: r.intentId, raw_text: rawText },
			});
		}
	}

	const unreadRows = await db
		.select({ n: count() })
		.from(notifications)
		.where(
			and(
				eq(notifications.userId, sub),
				isNull(notifications.readAt),
				visibleTo(db, sub),
			),
		);
	const lastId = page[page.length - 1]?.id;
	return c.json(
		{
			items,
			next_cursor:
				hasMore && lastId !== undefined ? encodeCursor(lastId) : null,
			unread_count: unreadRows[0]?.n ?? 0,
		},
		200,
	);
});

notificationRoutes.post("/read", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const parsed = notificationReadRequestSchema.safeParse(raw);
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	// 本人の未読だけを対象にする。対象が無くても一律204(冪等・存在の探索にしない)
	await dbOf(c.env)
		.update(notifications)
		.set({ readAt: systemClock.now() })
		.where(
			and(
				eq(notifications.userId, sub),
				isNull(notifications.readAt),
				lte(notifications.id, parsed.data.up_to_id),
			),
		);
	return c.body(null, 204);
});
