/**
 * 変更系APIの成功後にWeb Pushを送り出すミドルウェア(F7b設計 §5.1 手順2)。
 * 応答は待たせず、waitUntilで未送信のpendingをその場で拾う。
 * 取りこぼしはCronの回収(§5.6)が担うので、失敗はログだけで外へ出さない。
 */

import { drizzle } from "drizzle-orm/d1";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";
import { flushPush } from "./dispatch";
import { pushSenderOf } from "./sender";

const logger = createLogger();

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

export const pushFlushAfterWrite: MiddlewareHandler<AppEnv> = async (
	c,
	next,
) => {
	await next();
	if (!WRITE_METHODS.has(c.req.method)) return;
	if (c.res.status < 200 || c.res.status >= 300) return;
	c.executionCtx.waitUntil(
		flushPush(drizzle(c.env.DB), pushSenderOf(c.env), systemClock.now(), {
			minAgeMs: 0,
		}).then(
			() => undefined,
			(error: unknown) => {
				logger.warn("push.flush.failed", {
					error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
				});
			},
		),
	);
};
