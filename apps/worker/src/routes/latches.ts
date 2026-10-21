/**
 * LATCH(提案)APIルート(F4a設計 §4.1・docs/05 §3.2)。
 * - GET /v1/latches?type=proposals|matched: 自分が参加する提案(proposed/partial_accept)・
 *   成立(matched・completed・F5設計 §3)の一覧。id降順・cursor/limitはintents一覧と同方式。保留(candidate)は含めない
 * - GET /v1/latches/{id}: 単一取得。参加しない・存在しない・保留中(candidate)は一律404
 *   (成立後に個別に離脱した参加者は一覧・単一取得・各操作とも非参加と同じ扱い・F4b設計 §3.4)
 * - POST /{id}/response・/response/retract・/leave・/defer-reason: 成功は操作後のLatchDTO(200)。
 *   RespondFailureの写像: not_found→404・その他→400 VALIDATION_FAILED(details.reasons=[reason])
 * - DELETE /{id}: 表示から消す(F6a設計 §2.3)。成功は204・失敗の写像はRespondFailureと同じ
 * - /leave・DELETEの成功後はチャットの接続へclosedを知らせる(F6a設計 §2.4・最善努力)
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockを使う
 */

import {
	deferReasonRequestSchema,
	type LatchDTO,
	type LatchResponseValue,
	latchResponseRequestSchema,
} from "@latch/shared";
import {
	and,
	desc,
	eq,
	exists,
	inArray,
	isNull,
	lt,
	ne,
	or,
} from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { chatSummary } from "../chat/messages";
import { notifyClosed } from "../chat/notify";
import { systemClock } from "../clock/clock";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	users,
} from "../db/schema";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { closedTargetsAfterLeave, hideLatch } from "../latches/hide";
import {
	leave,
	type RespondResult,
	respond,
	retract,
	saveDeferReason,
} from "../latches/respond";
import { toLatchDto } from "../latches/view";

/** LATCH APIのサブアプリ。index.tsが /v1/latches にマウントする */
export const latchRoutes = new Hono<AppEnv>();

const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** JSONボディを読む。空ボディは{}・JSON不正はundefined(400扱い)(intents.tsと同一のhelper) */
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

/** 404。参加しない・存在しない・保留中は区別しない(docs/05 §3.1) */
const notFound = () => errorJson("NOT_FOUND", "LATCHが見つかりません");

/** requireRegisteredが保証するため到達しない防御応答 */
const unauthorized = () =>
	errorJson(
		"UNAUTHORIZED",
		"この操作には登録済みユーザーのアクセストークンが必要です",
	);

/** 一覧cursorの不透明化(intents一覧と同方式・docs/05 §3.1) */
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
 * 自分が参加するLATCHをLatchDTOにして返す。参加しない・存在しない・candidateはnull。
 * 成立後(matched・completed・matched経由のcancelled)のみ自分を除くmembersとproposalを含める(§4.5)。
 * 離脱済み(left_atあり)の参加者は非参加と同じ扱いで、members・participants_countからも除く
 * (F4b設計 §3.4)。includeLeftは離脱操作そのものの応答に限り、離脱した本人へ返すために使う
 */
const loadLatchDto = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	options: { includeLeft?: boolean } = {},
): Promise<LatchDTO | null> => {
	const [row] = await db
		.select({ latch: latches })
		.from(latches)
		.innerJoin(
			latchMembers,
			and(
				eq(latchMembers.latchId, latches.id),
				eq(latchMembers.userId, userId),
				options.includeLeft === true ? undefined : isNull(latchMembers.leftAt),
				// 本人が一覧から消したLATCHは非参加と同じ扱い(F6a設計 §2.3)。離脱応答でも変えない
				isNull(latchMembers.hiddenAt),
			),
		)
		.where(and(eq(latches.id, latchId), ne(latches.status, "candidate")));
	if (row === undefined) {
		return null;
	}
	const latch = row.latch;
	const memberRows = await db
		.select({ user: users })
		.from(latchMembers)
		.innerJoin(users, eq(users.id, latchMembers.userId))
		.where(and(eq(latchMembers.latchId, latchId), isNull(latchMembers.leftAt)));
	const [mine] = await db
		.select({ response: latchResponses.response })
		.from(latchResponses)
		.where(
			and(
				eq(latchResponses.latchId, latchId),
				eq(latchResponses.userId, userId),
				isNull(latchResponses.retractedAt),
			),
		);
	// 自分側のIntent: intent_idsのうちintents.user_idが自分のもの(F4c設計 §2)
	const [myIntent] =
		latch.intentIds.length === 0
			? []
			: await db
					.select({ id: intents.id })
					.from(intents)
					.where(
						and(
							inArray(intents.id, latch.intentIds),
							eq(intents.userId, userId),
						),
					)
					.limit(1);
	// Intent削除後もintent_idsは残る(FKなし)ため、見つからなくても404にせずnullで返す
	// 成立時刻: to=matchedの状態記録のcreated_at。matched・completed・matched経由のcancelled(leave等)にある
	let matchedAt: Date | null = null;
	if (
		latch.status === "matched" ||
		latch.status === "completed" ||
		latch.status === "cancelled"
	) {
		const [ev] = await db
			.select({ createdAt: latchStatusEvents.createdAt })
			.from(latchStatusEvents)
			.where(
				and(
					eq(latchStatusEvents.latchId, latchId),
					eq(latchStatusEvents.toStatus, "matched"),
				),
			)
			.limit(1);
		matchedAt = ev?.createdAt ?? null;
	}
	const revealed = latch.status === "matched" || matchedAt !== null;
	// 最終メッセージ・未読数はmembersと同じ成立後だけ(F6a設計 §3.2)
	const chat = revealed ? await chatSummary(db, latchId, userId) : undefined;
	return toLatchDto(latch, {
		participantsCount: memberRows.length,
		myResponse: (mine?.response ?? null) as LatchResponseValue | null,
		myIntentId: myIntent?.id ?? null,
		matchedAt,
		chat,
		members: revealed
			? memberRows.filter((m) => m.user.id !== userId).map((m) => m.user)
			: undefined,
	});
};

/** RespondResultをHTTP応答へ写す。成功は操作後のLatchDTO(200) */
const respondResultToResponse = async (
	c: Context<AppEnv>,
	result: RespondResult,
	userId: string,
	options: { includeLeft?: boolean } = {},
) => {
	if (!result.ok) {
		const r =
			result.reason === "not_found"
				? notFound()
				: errorJson("VALIDATION_FAILED", "この操作はできません", {
						reasons: [result.reason],
					});
		return c.json(r.body, r.status);
	}
	const dto = await loadLatchDto(dbOf(c.env), result.latchId, userId, options);
	if (dto === null) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	return c.json(dto, 200);
};

latchRoutes.get("/", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const type = c.req.query("type");
	if (type !== "proposals" && type !== "matched") {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	let limit = 20;
	const limitParam = c.req.query("limit");
	if (limitParam !== undefined) {
		if (!/^[0-9]{1,2}$/u.test(limitParam)) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		const parsedLimit = Number(limitParam);
		if (parsedLimit < 1 || parsedLimit > 50) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		limit = parsedLimit;
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
	// 成立一覧はmatched経由のcancelled(相手の離脱で終わったもの)も含める(F6a設計 §3.3)
	const conditions = [
		type === "proposals"
			? inArray(latches.status, ["proposed", "partial_accept"])
			: or(
					inArray(latches.status, ["matched", "completed"]),
					and(
						eq(latches.status, "cancelled"),
						exists(
							db
								.select({ one: latchStatusEvents.id })
								.from(latchStatusEvents)
								.where(
									and(
										eq(latchStatusEvents.latchId, latches.id),
										eq(latchStatusEvents.toStatus, "matched"),
									),
								),
						),
					),
				),
	];
	if (cursorId !== undefined) {
		conditions.push(lt(latches.id, cursorId));
	}
	// 終端判定のためlimit+1件取得する(id降順・自分が参加するもののみ)
	const rows = await db
		.select({ id: latches.id })
		.from(latches)
		.innerJoin(
			latchMembers,
			and(
				eq(latchMembers.latchId, latches.id),
				eq(latchMembers.userId, sub),
				isNull(latchMembers.leftAt),
				isNull(latchMembers.hiddenAt),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(latches.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const pageIds = (hasMore ? rows.slice(0, limit) : rows).map((r) => r.id);
	const items: LatchDTO[] = [];
	for (const id of pageIds) {
		const dto = await loadLatchDto(db, id, sub);
		if (dto !== null) {
			items.push(dto);
		}
	}
	const lastId = pageIds[pageIds.length - 1];
	return c.json(
		{
			items,
			next_cursor:
				hasMore && lastId !== undefined ? encodeCursor(lastId) : null,
		},
		200,
	);
});

latchRoutes.get("/:id", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const dto = await loadLatchDto(dbOf(c.env), c.req.param("id"), sub);
	if (dto === null) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	return c.json(dto, 200);
});

latchRoutes.post("/:id/response", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const parsed = latchResponseRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const result = await respond(
		dbOf(c.env),
		c.req.param("id"),
		sub,
		parsed.data.response,
		systemClock.now(),
	);
	return respondResultToResponse(c, result, sub);
});

latchRoutes.post("/:id/response/retract", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const result = await retract(
		dbOf(c.env),
		c.req.param("id"),
		sub,
		systemClock.now(),
	);
	return respondResultToResponse(c, result, sub);
});

latchRoutes.post("/:id/leave", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const id = c.req.param("id");
	const result = await leave(db, id, sub, systemClock.now());
	if (result.ok) {
		// 取り消しなら全員・本人だけが抜けたなら本人の接続へclosed(F6a設計 §2.4)
		await notifyClosed(c.env, id, await closedTargetsAfterLeave(db, id, sub));
	}
	// 個別に離脱した本人は以降非参加の扱いだが、この操作の応答だけは操作後の状態を返す(F4b設計 §3.4)
	return respondResultToResponse(c, result, sub, { includeLeft: true });
});

latchRoutes.delete("/:id", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const id = c.req.param("id");
	const result = await hideLatch(dbOf(c.env), id, sub, systemClock.now());
	if (!result.ok) return respondResultToResponse(c, result, sub);
	// 取り消しなら全員・本人だけが抜けたなら本人の接続へclosed。表示を隠すだけなら知らせない(F6a設計 §2.4)
	if (result.closedFor !== "none") {
		await notifyClosed(c.env, id, result.closedFor === "all" ? null : [sub]);
	}
	return c.body(null, 204);
});

latchRoutes.post("/:id/defer-reason", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const parsed = deferReasonRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const result = await saveDeferReason(
		dbOf(c.env),
		c.req.param("id"),
		sub,
		parsed.data.reason,
	);
	return respondResultToResponse(c, result, sub);
});
