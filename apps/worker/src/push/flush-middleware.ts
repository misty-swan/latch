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
	// この要求の開始時刻。これより前に作られた未送信は毎分Cronの回収に任せる(#39)
	const startedAt = systemClock.now();
	await next();
	if (!WRITE_METHODS.has(c.req.method)) return;
	if (c.res.status < 200 || c.res.status >= 300) return;
	// ここから先は例外を外へ出さない(書き込みは確定済み。VAPID鍵の欠落などで
	// 成功した書き込みを500にしない)
	try {
		const { env } = c;
		c.executionCtx.waitUntil(
			(async () => {
				try {
					await flushPush(drizzle(env.DB), pushSenderOf(env), systemClock, {
						minAgeMs: 0,
						createdFrom: startedAt,
					});
				} catch (error) {
					logger.warn("push.flush.failed", {
						error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
					});
				}
			})(),
		);
	} catch (error) {
		logger.warn("push.flush.failed", {
			error_code: errorCodeOf(error, "PUSH_FLUSH_FAILED"),
		});
	}
};
