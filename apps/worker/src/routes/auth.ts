/**
 * 認証APIルート(docs/05 §3.2: POST /v1/auth/token・/v1/auth/refresh・/v1/auth/logout)。
 * - token: IdPトークン検証+JWT発行。登録済みはUserDTO+新規リフレッシュ族(既存族は再利用せず
 *   都度新設・docs/04 §4の族=ログインセッション単位)、未登録は登録前JWT(sub無し・
 *   refresh_token=null。refresh_familiesはusersへのFKを持つため未登録では族を作れない)
 * - refresh: 回転式リフレッシュトークンの検証と回転(旧トークン再利用は族失効+401・docs/04 §4)
 * - logout: アクセストークンのjtiをKV失効リストへTTL=残り寿命で登録し(docs/04 §4)、
 *   任意のrefresh_tokenがあれば属する族を失効させる(docs/05 §2.5)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点(composition root)のためsystemClockをimportして使う
 */

import {
	authTokenRequestSchema,
	logoutRequestSchema,
	refreshRequestSchema,
	type UserDTO,
} from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { IdpTokenError, verifyIdpToken } from "../auth/idp";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "../auth/jwt";
import {
	type AppEnv,
	REVOCATION_KV_PREFIX,
	requireAuth,
} from "../auth/middleware";
import {
	createRefreshFamily,
	revokeFamilyByToken,
	rotateRefreshToken,
} from "../auth/refresh";
import { systemClock } from "../clock/clock";
import { users } from "../db/schema";
import { jwtSecret } from "../env";
import { errorJson } from "../http/errors";
import { createLogger } from "../logging/logger";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。token・user_idは決して出力しない */
const logger = createLogger();

/** 認証APIのサブアプリ。index.tsが /v1/auth にマウントする(docs/05 §3.2) */
export const authRoutes = new Hono<AppEnv>();

/** JSONボディを読む。空ボディは{}(logoutのbody省略を許す)、JSON不正はundefined(400扱い) */
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

/** users行→UserDTO(docs/05 §3.3: has_icon=icon_keyの有無・URL生成はAPIが担う) */
const toUserDto = (user: typeof users.$inferSelect): UserDTO => ({
	id: user.id,
	display_name: user.displayName,
	bio: user.bio,
	has_icon: user.iconKey !== null,
});

// IdPトークン検証失敗時にクライアントへ返す固定文言。
// IdpTokenErrorの内部詳細(理由コード・joseの例外)は漏らさない(docs/05 §3.1)
const IDP_AUTH_FAILED_MESSAGE = "認証に失敗しました。もう一度お試しください";

authRoutes.post("/token", async (c) => {
	const parsed = authTokenRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	try {
		const verified = await verifyIdpToken(
			c.env,
			parsed.data.provider,
			parsed.data.idp_token,
		);
		// (auth_provider, auth_subject)で登録済みユーザーを検索(docs/05 §3.2・UNIQUE索引)
		const [user] = await drizzle(c.env.DB)
			.select()
			.from(users)
			.where(
				and(
					eq(users.authProvider, verified.provider),
					eq(users.authSubject, verified.subject),
					// 退会済み(deleted)は未登録扱い(docs/05 §2.2: status=activeのみ)
					eq(users.status, "active"),
				),
			);
		if (user === undefined) {
			// 未登録: 登録前JWT(sub無し・idp claimsのみ・docs/04 §4・05 §2.3)
			const accessToken = await signAccessToken(jwtSecret(c.env), systemClock, {
				jti: crypto.randomUUID(),
				idpProvider: verified.provider,
				idpSubject: verified.subject,
			});
			logger.info("auth.token.issued", { status: "preregistration" });
			return c.json({
				access_token: accessToken,
				refresh_token: null,
				expires_in: ACCESS_TOKEN_TTL_SECONDS,
				user: null,
				registration_required: true,
			});
		}
		// 登録済み: sub付きJWT+新規リフレッシュ族(既存族は再利用せず都度新設・docs/04 §4)
		const [accessToken, refresh] = await Promise.all([
			signAccessToken(jwtSecret(c.env), systemClock, {
				jti: crypto.randomUUID(),
				sub: user.id,
				idpProvider: verified.provider,
				idpSubject: verified.subject,
			}),
			createRefreshFamily(c.env, systemClock, user.id),
		]);
		logger.info("auth.token.issued", { status: "registered" });
		return c.json({
			access_token: accessToken,
			refresh_token: refresh.token,
			expires_in: ACCESS_TOKEN_TTL_SECONDS,
			user: toUserDto(user),
			registration_required: false,
		});
	} catch (error) {
		if (error instanceof IdpTokenError) {
			// IdPトークン検証の失敗は一律401 UNAUTHORIZED(固定文言・docs/05 §3.1)
			logger.warn("auth.token.idp_rejected", { error_code: "UNAUTHORIZED" });
			const r = errorJson("UNAUTHORIZED", IDP_AUTH_FAILED_MESSAGE);
			return c.json(r.body, r.status);
		}
		throw error;
	}
});

authRoutes.post("/refresh", async (c) => {
	const parsed = refreshRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const result = await rotateRefreshToken(
		c.env,
		systemClock,
		parsed.data.refresh_token,
	);
	if (!result.ok) {
		// TOKEN_EXPIRED=有効期限切れ(再ログイン要求)、UNAUTHORIZED=未知トークン・
		// 再利用検出(族は失効済み)・status異常(docs/04 §4・05 §3.1)
		const r =
			result.code === "TOKEN_EXPIRED"
				? errorJson(
						"TOKEN_EXPIRED",
						"リフレッシュトークンの有効期限が切れています。再ログインしてください",
					)
				: errorJson("UNAUTHORIZED", "リフレッシュトークンが不正です");
		logger.warn("auth.refresh.rejected", { error_code: result.code });
		return c.json(r.body, r.status);
	}
	// 新しいアクセストークンも登録済みJWT(sub+idp claims)。族はusersへのFKを持つため
	// ユーザー行は常に存在する(欠落は防御的に401へ倒す)
	const [user] = await drizzle(c.env.DB)
		.select()
		.from(users)
		.where(eq(users.id, result.userId));
	if (user === undefined) {
		logger.warn("auth.refresh.rejected", { error_code: "UNAUTHORIZED" });
		const r = errorJson("UNAUTHORIZED", "リフレッシュトークンが不正です");
		return c.json(r.body, r.status);
	}
	const accessToken = await signAccessToken(jwtSecret(c.env), systemClock, {
		jti: crypto.randomUUID(),
		sub: user.id,
		idpProvider: user.authProvider,
		idpSubject: user.authSubject,
	});
	logger.info("auth.refresh.rotated");
	return c.json({
		access_token: accessToken,
		refresh_token: result.refreshToken,
		expires_in: ACCESS_TOKEN_TTL_SECONDS,
	});
});

authRoutes.post("/logout", requireAuth, async (c) => {
	const parsed = logoutRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const claims = c.var.auth;
	// アクセストークンのjtiをKV失効リストへ登録(docs/04 §4: TTL=残り寿命。
	// KVの最小TTL=60秒にクランプ)
	const nowMs = systemClock.now().getTime();
	const ttlSeconds = Math.max(
		60,
		Math.floor((claims.exp * 1000 - nowMs) / 1000),
	);
	await c.env.REVOCATION_KV.put(`${REVOCATION_KV_PREFIX}${claims.jti}`, "1", {
		expirationTtl: ttlSeconds,
	});
	// bodyのrefresh_token(任意)があれば属する族を失効させる(docs/05 §2.5・冪等)
	if (parsed.data.refresh_token !== undefined) {
		await revokeFamilyByToken(c.env, parsed.data.refresh_token);
	}
	logger.info("auth.logout");
	// 204はボディを持たない
	return c.body(null, 204);
});
