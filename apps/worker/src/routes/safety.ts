/**
 * 安全のAPIルート(F7a設計 §1・§2.1)。
 * - POST /v1/users/{user_id}/block: 201(新規)/ 200(既にブロック済み・効果は再適用)。本文なし。
 *   自分自身は400 VALIDATION_FAILED(self_block)・対象外/存在しない/退会済みは一律404
 * - DELETE /v1/users/{user_id}/block: 204(ブロックしていなくても204)
 * - GET /v1/blocks: 200 BlockListResponse(新しい順)
 * - ブロックで本人が離脱したmatchedのLATCHは、leaveと同じくチャットの接続へclosedを知らせる(F6a設計 §2.4)
 * - 応答とログにブロックの相手を記録しない(docs/08 §6)
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockを使う
 */

import type { BlockListResponse } from "@latch/shared";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { notifyClosed } from "../chat/notify";
import { systemClock } from "../clock/clock";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { closedTargetsAfterLeave } from "../latches/hide";
import { blockUser, listBlocks, unblockUser } from "../safety/block";

/** 安全のAPIのサブアプリ。index.tsが /v1 にマウントする */
export const safetyRoutes = new Hono<AppEnv>();

const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** requireRegisteredが保証するため到達しない防御応答 */
const unauthorized = () =>
	errorJson(
		"UNAUTHORIZED",
		"この操作には登録済みユーザーのアクセストークンが必要です",
	);

safetyRoutes.post("/users/:user_id/block", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const outcome = await blockUser(
		db,
		sub,
		c.req.param("user_id"),
		systemClock.now(),
	);
	if (!outcome.ok) {
		const r =
			outcome.reason === "self_block"
				? errorJson("VALIDATION_FAILED", "自分自身はブロックできません", {
						reasons: ["self_block"],
					})
				: errorJson("NOT_FOUND", "ユーザーが見つかりません");
		return c.json(r.body, r.status);
	}
	// 取り消しなら全員・本人だけが抜けたなら本人の接続へclosed(F7a設計 §2.2・F6a設計 §2.4)
	for (const id of outcome.leftLatchIds) {
		await notifyClosed(c.env, id, await closedTargetsAfterLeave(db, id, sub));
	}
	return c.body(null, outcome.created ? 201 : 200);
});

safetyRoutes.delete("/users/:user_id/block", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	await unblockUser(dbOf(c.env), sub, c.req.param("user_id"));
	return c.body(null, 204);
});

safetyRoutes.get("/blocks", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = unauthorized();
		return c.json(r.body, r.status);
	}
	const body: BlockListResponse = {
		blocks: await listBlocks(dbOf(c.env), sub),
	};
	return c.json(body, 200);
});
