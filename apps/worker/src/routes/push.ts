/**
 * Web Push購読のAPIルート(F7b設計 §4)。
 * - GET /v1/push/vapid-public-key: 200 {public_key}
 * - POST /v1/push-subscriptions: 201(新規)/ 200(既存endpointの更新)。本文なし。
 *   形の誤りは400 VALIDATION_FAILED(details.reasonsに理由コード)
 * - DELETE /v1/push-subscriptions: 204(本人の行だけ消す・無い行や他人の行でも204)
 * - ログにendpoint・鍵を出さない
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockを使う
 */

import {
	PUSH_LIMITS,
	pushSubscriptionDeleteRequestSchema,
	pushSubscriptionRequestSchema,
} from "@latch/shared";
import { and, count, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { base64url } from "jose";
import { ulid } from "ulid";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { pushSubscriptions } from "../db/schema";
import { vapidKeysOf } from "../env";
import { errorJson } from "../http/errors";
import { isAllowedPushEndpoint } from "../push/endpoints";

/** Push購読のサブアプリ。index.tsが /v1 にマウントする */
export const pushRoutes = new Hono<AppEnv>();

const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

/** base64urlを復号して長さを確かめる(復号失敗も不正) */
const decodesTo = (value: string, bytes: number): Uint8Array | null => {
	try {
		const raw = base64url.decode(value);
		return raw.length === bytes ? raw : null;
	} catch {
		return null;
	}
};

const validationFailed = (reasons: string[]) => {
	const r = errorJson(
		"VALIDATION_FAILED",
		"リクエストの形式が正しくありません",
		{ reasons },
	);
	return r;
};

pushRoutes.get("/push/vapid-public-key", requireRegistered, (c) =>
	c.json({ public_key: vapidKeysOf(c.env).publicKey }, 200),
);

pushRoutes.post("/push-subscriptions", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const raw: unknown = await c.req.json().catch(() => null);
	const parsed = pushSubscriptionRequestSchema.safeParse(raw);
	if (!parsed.success) {
		const r = validationFailed(
			parsed.error.issues.map((i) => i.path.join(".") || i.code),
		);
		return c.json(r.body, r.status);
	}
	const { endpoint, keys } = parsed.data;
	const p256dh = decodesTo(keys.p256dh, P256DH_BYTES);
	if (
		p256dh === null ||
		p256dh[0] !== 0x04 ||
		decodesTo(keys.auth, AUTH_BYTES) === null
	) {
		const r = validationFailed(["invalid_push_keys"]);
		return c.json(r.body, r.status);
	}
	if (!isAllowedPushEndpoint(endpoint)) {
		const r = validationFailed(["push_endpoint_not_allowed"]);
		return c.json(r.body, r.status);
	}

	const db = drizzle(c.env.DB);
	const existing = await db
		.select({ id: pushSubscriptions.id })
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.endpoint, endpoint))
		.get();
	// 上限は本人のactive件数(このendpointの行を除く)で判定する
	const active = await db
		.select({ n: count() })
		.from(pushSubscriptions)
		.where(
			and(
				eq(pushSubscriptions.userId, sub),
				eq(pushSubscriptions.status, "active"),
				ne(pushSubscriptions.endpoint, endpoint),
			),
		)
		.get();
	if ((active?.n ?? 0) >= PUSH_LIMITS.SUBSCRIPTIONS_PER_USER) {
		const r = validationFailed(["push_subscription_limit"]);
		return c.json(r.body, r.status);
	}
	// 同じendpointは本人へ付け替え・鍵を更新・activeへ戻す(端末の持ち主が変わった場合など)
	await db
		.insert(pushSubscriptions)
		.values({
			id: ulid(),
			userId: sub,
			endpoint,
			p256dh: keys.p256dh,
			auth: keys.auth,
			status: "active",
			createdAt: systemClock.now(),
		})
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: {
				userId: sub,
				p256dh: keys.p256dh,
				auth: keys.auth,
				status: "active",
			},
		});
	return c.body(null, existing === undefined ? 201 : 200);
});

pushRoutes.delete("/push-subscriptions", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const raw: unknown = await c.req.json().catch(() => null);
	const parsed = pushSubscriptionDeleteRequestSchema.safeParse(raw);
	if (!parsed.success) {
		const r = validationFailed(
			parsed.error.issues.map((i) => i.path.join(".") || i.code),
		);
		return c.json(r.body, r.status);
	}
	await drizzle(c.env.DB)
		.delete(pushSubscriptions)
		.where(
			and(
				eq(pushSubscriptions.userId, sub),
				eq(pushSubscriptions.endpoint, parsed.data.endpoint),
			),
		);
	return c.body(null, 204);
});
