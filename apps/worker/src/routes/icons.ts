/**
 * アイコンAPIルート(docs/05 §3.2: POST/DELETE /v1/users/me/icon・
 * GET /v1/users/{user_id}/icon・docs/05 §2.3: R2キー={user ULID}/{ULID})。
 * - POST /v1/users/me/icon: 生ボディをmagic bytesで検証してからR2へ保存する
 *   (docs/08 §11: 形式・サイズをWorkerで検証・Content-Type申告は信頼しない)。
 *   キーはアップロードごとに新採番し、旧オブジェクトがあれば削除する
 * - DELETE /v1/users/me/icon: R2オブジェクト削除+icon_key=null。アイコン無し
 *   でも204(冪等)
 * - GET /v1/users/{user_id}/icon: 未認証。R2からストリーム配信し・Content-Typeは
 *   アップロード時に検証して固定した値・Cache-Control: private(docs/05 §3.2)。
 *   ユーザー不在・deleted・アイコン無しは区別せず404(存在を露見させない)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockをimportして使う
 */

import { LIMITS } from "@latch/shared";
import { eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { users } from "../db/schema";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { newUlid } from "../ids";
import { sniffImage } from "../images/validate";
import { createLogger } from "../logging/logger";
import { toUserDto } from "./users";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。user_id・表示名は決して出力しない */
const logger = createLogger();

/**
 * アイコンAPIのサブアプリ。index.tsがuserRoutesと同じ /v1/users にマウントする
 * (docs/05 §3.2)。パスマッチの競合を避けるため /me/icon を /:user_id/icon より
 * 先に定義する
 */
export const iconRoutes = new Hono<AppEnv>();

/** D1接続。envのバインディングからdrizzleインスタンスを作る(軽量オブジェクトのため関数ごとの生成でよい) */
const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

iconRoutes.post("/me/icon", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	// 生ボディをバイト列として受け取る(Content-Type申告は使わない・docs/08 §11)
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (bytes.byteLength > LIMITS.ICON_MAX_BYTES) {
		logger.warn("icons.upload.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"アイコンのサイズが上限(1MB)を超えています",
		);
		return c.json(r.body, r.status);
	}
	const type = sniffImage(bytes);
	if (type === null) {
		// 拡張子偽装含め・形式は先頭バイトのみで判定する(docs/08 §11)
		logger.warn("icons.upload.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"アイコンはPNG・JPEG・WebP形式の画像にしてください",
		);
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const [user] = await db.select().from(users).where(eq(users.id, sub));
	if (user === undefined || user.status === "deleted") {
		// 退会済みは未登録扱い(docs/05 §2.2)。GET /v1/users/meと同じ扱い
		const r = errorJson("NOT_FOUND", "ユーザーが見つかりません");
		return c.json(r.body, r.status);
	}
	// キーはアップロードごとに新採番する(docs/05 §2.3: キー={user ULID}/{ULID})
	const key = `${sub}/${newUlid()}`;
	// コンテンツ種別を検証結果で固定して保存する(docs/08 §11)
	await c.env.ICONS.put(key, bytes, { httpMetadata: { contentType: type } });
	const [updated] = await db
		.update(users)
		.set({ iconKey: key, updatedAt: systemClock.now() })
		.where(eq(users.id, sub))
		.returning();
	if (updated === undefined) {
		const r = errorJson("INTERNAL", "アイコンの保存に失敗しました");
		return c.json(r.body, r.status);
	}
	// 差し替え後の後始末。旧キーのオブジェクトがあれば削除する(05 §2.3)
	if (user.iconKey !== null) {
		await c.env.ICONS.delete(user.iconKey);
	}
	logger.info("icons.uploaded");
	return c.json(toUserDto(updated), 201);
});

iconRoutes.delete("/me/icon", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const [user] = await db.select().from(users).where(eq(users.id, sub));
	if (user === undefined || user.status === "deleted") {
		// 退会済みは未登録扱い(docs/05 §2.2)。GET /v1/users/meと同じ扱い
		const r = errorJson("NOT_FOUND", "ユーザーが見つかりません");
		return c.json(r.body, r.status);
	}
	if (user.iconKey !== null) {
		// R2オブジェクト削除+icon_key=null(docs/05 §2.3・docs/08 §11)
		await c.env.ICONS.delete(user.iconKey);
		await db
			.update(users)
			.set({ iconKey: null, updatedAt: systemClock.now() })
			.where(eq(users.id, sub));
	}
	// アイコン無しでも204(冪等・docs/05 §3.2)
	logger.info("icons.deleted");
	return c.body(null, 204);
});

iconRoutes.get("/:user_id/icon", async (c) => {
	const userId = c.req.param("user_id");
	const db = dbOf(c.env);
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	// ユーザー不在・deleted・アイコン無しは区別せず404(存在を露見させない・docs/05 §3.2)
	if (
		user === undefined ||
		user.status === "deleted" ||
		user.iconKey === null
	) {
		const r = errorJson("NOT_FOUND", "アイコンが見つかりません");
		return c.json(r.body, r.status);
	}
	const object = await c.env.ICONS.get(user.iconKey);
	if (object === null) {
		// D1上はicon_keyありでもR2オブジェクトが無い場合(防御)
		const r = errorJson("NOT_FOUND", "アイコンが見つかりません");
		return c.json(r.body, r.status);
	}
	// ストリーム配信(docs/05 §2.3)。Content-Typeはアップロード時にWorkerが
	// 検証してR2へ固定した値(docs/08 §11)・privateで共有キャッシュに載せない
	return new Response(object.body, {
		headers: {
			"Content-Type":
				object.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "private, max-age=3600",
		},
	});
});
