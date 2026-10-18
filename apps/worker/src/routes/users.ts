/**
 * ユーザーAPIルート(docs/05 §3.2: POST /v1/users・GET/PATCH /v1/users/me)。
 * - POST /v1/users: 登録前JWTのidp claimsでusers行を作る(初回登録)。18歳検証を
 *   最優先で行い(UNDER_AGE)、同一(provider, subject)のactive行があれば400、
 *   削除済み(deleted)行は再利用する(05 §2.5: 削除は行を残すためid・auth列は不変)。
 *   成功応答はsub付きJWTへの付け替えと新規リフレッシュ族(docs/04 §4・05 §2.3)
 * - GET /v1/users/me: 自ユーザーのUserDTO。行無し・status=deletedは404(05 §2.2:
 *   登録済みはstatus=activeのみ)
 * - PATCH /v1/users/me: display_name・bioの部分更新(1フィールド以上必須)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点(composition root)のためsystemClockをimportして使う
 */

import {
	patchMeRequestSchema,
	registerUserRequestSchema,
	type UserDTO,
} from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { ageAtYears } from "../auth/age";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "../auth/jwt";
import {
	type AppEnv,
	requirePreRegistration,
	requireRegistered,
} from "../auth/middleware";
import { createRefreshFamily } from "../auth/refresh";
import { systemClock } from "../clock/clock";
import { users } from "../db/schema";
import { type Env, jwtSecret } from "../env";
import { errorJson } from "../http/errors";
import { newUlid } from "../ids";
import { createLogger } from "../logging/logger";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。user_id・表示名は決して出力しない */
const logger = createLogger();

/** ユーザーAPIのサブアプリ。index.tsが /v1/users にマウントする(docs/05 §3.2) */
export const userRoutes = new Hono<AppEnv>();

/** D1接続。envのバインディングからdrizzleインスタンスを作る(軽量オブジェクトのため関数ごとの生成でよい) */
const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** JSONボディを読む。空ボディは{}(PATCHの空オブジェクト検証に効かせる)、JSON不正はundefined(400扱い) */
const readJsonBody = async (c: Context<AppEnv>): Promise<unknown> => {
	try {
		const text = await c.req.text();
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** 400 VALIDATION_FAILED(リクエスト検証の失敗・docs/05 §3.1) */
const validationFailed = () =>
	errorJson("VALIDATION_FAILED", "リクエストボディが不正です");

/** users行→UserDTO(docs/05 §3.3: has_icon=icon_keyの有無・URL生成はAPIが担う)。アイコンAPI(routes/icons.ts)でも使う */
export const toUserDto = (user: typeof users.$inferSelect): UserDTO => ({
	id: user.id,
	display_name: user.displayName,
	bio: user.bio,
	has_icon: user.iconKey !== null,
});

userRoutes.post("/", requirePreRegistration, async (c) => {
	const parsed = registerUserRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const claims = c.var.auth;
	const { idpProvider, idpSubject } = claims;
	if (idpProvider === undefined || idpSubject === undefined) {
		// requirePreRegistrationが保証する(到達しない・防御・docs/05 §3.1)
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録前のアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	// 18歳検証を最優先で返す(docs/05 §3.2)。競合確認・行の再利用より先に行う
	if (ageAtYears(systemClock.now(), parsed.data.birth_date) < 18) {
		logger.warn("users.register.rejected", { error_code: "UNDER_AGE" });
		const r = errorJson("UNDER_AGE", "利用登録は18歳以上の方に限ります");
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const now = systemClock.now();
	// 登録前JWTのidp claimsで検索(ステータス問わず・docs/05 §2.2のUNIQUE索引)
	const [existing] = await db
		.select()
		.from(users)
		.where(
			and(
				eq(users.authProvider, idpProvider),
				eq(users.authSubject, idpSubject),
			),
		);
	if (existing !== undefined && existing.status === "active") {
		// 登録の競合: 同一(provider, subject)のactive行が既にある(docs/05 §3.2)
		logger.warn("users.register.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson("VALIDATION_FAILED", "既に登録済みです");
		return c.json(r.body, r.status);
	}
	let user: typeof users.$inferSelect;
	if (existing !== undefined) {
		// 削除済み行の再利用(docs/05 §2.5: 削除は行を残す)。id・auth列は不変で
		// status/表示名/bio/birth_date/updated_atを更新する
		const [reclaimed] = await db
			.update(users)
			.set({
				status: "active",
				displayName: parsed.data.display_name,
				bio: parsed.data.bio,
				birthDate: parsed.data.birth_date,
				updatedAt: now,
			})
			.where(eq(users.id, existing.id))
			.returning();
		if (reclaimed === undefined) {
			const r = errorJson("INTERNAL", "ユーザー登録に失敗しました");
			return c.json(r.body, r.status);
		}
		user = reclaimed;
	} else {
		try {
			const [inserted] = await db
				.insert(users)
				.values({
					id: newUlid(),
					authProvider: idpProvider,
					authSubject: idpSubject,
					actorType: "individual",
					displayName: parsed.data.display_name,
					bio: parsed.data.bio,
					iconKey: null,
					birthDate: parsed.data.birth_date,
					status: "active",
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (inserted === undefined) {
				const r = errorJson("INTERNAL", "ユーザー登録に失敗しました");
				return c.json(r.body, r.status);
			}
			user = inserted;
		} catch (error) {
			// 防御: SELECT後に並行登録でUNIQUE違反が起きた場合も400に倒す(docs/05 §3.2)
			if (
				error instanceof Error &&
				error.message.includes("UNIQUE constraint failed")
			) {
				logger.warn("users.register.rejected", {
					error_code: "VALIDATION_FAILED",
				});
				const r = errorJson("VALIDATION_FAILED", "既に登録済みです");
				return c.json(r.body, r.status);
			}
			throw error;
		}
	}
	// 登録でsub付きJWTに付け替え・族を新設する(docs/04 §4・05 §2.3・05 §3.2)
	const [accessToken, refresh] = await Promise.all([
		signAccessToken(jwtSecret(c.env), systemClock, {
			jti: crypto.randomUUID(),
			sub: user.id,
			idpProvider,
			idpSubject,
		}),
		createRefreshFamily(c.env, systemClock, user.id),
	]);
	logger.info("users.registered");
	return c.json(
		{
			user: toUserDto(user),
			access_token: accessToken,
			refresh_token: refresh.token,
			expires_in: ACCESS_TOKEN_TTL_SECONDS,
		},
		201,
	);
});

userRoutes.get("/me", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const [user] = await dbOf(c.env)
		.select()
		.from(users)
		.where(eq(users.id, sub));
	if (user === undefined || user.status === "deleted") {
		// 退会済みは未登録扱い(docs/05 §2.2)。行の存在も露見させない
		const r = errorJson("NOT_FOUND", "ユーザーが見つかりません");
		return c.json(r.body, r.status);
	}
	return c.json(toUserDto(user));
});

userRoutes.patch("/me", requireRegistered, async (c) => {
	const parsed = patchMeRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const [user] = await dbOf(c.env)
		.select()
		.from(users)
		.where(eq(users.id, sub));
	if (user === undefined || user.status === "deleted") {
		// 退会済みは未登録扱い(docs/05 §2.2)。GET meと同じく404
		const r = errorJson("NOT_FOUND", "ユーザーが見つかりません");
		return c.json(r.body, r.status);
	}
	// 部分更新: 指定されたフィールドのみ(1フィールド以上はスキーマのrefineが保証)
	const updates: Partial<typeof users.$inferInsert> = {
		updatedAt: systemClock.now(),
	};
	if (parsed.data.display_name !== undefined) {
		updates.displayName = parsed.data.display_name;
	}
	if (parsed.data.bio !== undefined) {
		updates.bio = parsed.data.bio;
	}
	const [updated] = await dbOf(c.env)
		.update(users)
		.set(updates)
		.where(eq(users.id, sub))
		.returning();
	if (updated === undefined) {
		const r = errorJson("INTERNAL", "プロフィールの更新に失敗しました");
		return c.json(r.body, r.status);
	}
	logger.info("users.me.updated");
	return c.json(toUserDto(updated));
});
