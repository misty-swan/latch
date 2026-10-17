/**
 * 認証ミドルウェア(docs/05 §3.1: Authorization: Bearer <JWT>・docs/04 §4)。
 * - requireAuth: 有効なBearer JWT必須。jtiがKV失効リストにあれば401。成功時c.set("auth", claims)
 * - requireRegistered: 登録済みユーザーのトークン(subあり)必須
 * - requirePreRegistration: 登録前トークン(idpProvider/idpSubjectあり・sub無し)必須
 * 各ミドルウェアは自己完結(requireAuthの検証+固有の検査)とし、next()は1回だけ呼ぶ。
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。期限切れのみTOKEN_EXPIRED、
 * それ以外の失敗は一律UNAUTHORIZED
 */

import type { MiddlewareHandler } from "hono";
import { type Env, jwtSecret } from "../env";
import { type ErrorResult, errorJson } from "../http/errors";
import { type AccessClaims, AccessTokenError, verifyAccessToken } from "./jwt";

/** Honoのジェネリクス。検証済みクレームをVariablesのauthに載せる */
export type AppEnv = {
	Bindings: Env;
	Variables: {
		auth: AccessClaims & { exp: number };
	};
};

/** 成功時のクレーム型(Variablesのauthにsetする値) */
type AuthClaims = AccessClaims & { exp: number };

/** アクセストークン失効リストのKVキー接頭辞(docs/04 §4: revocation:{jti}をTTL=残り寿命で格納) */
export const REVOCATION_KV_PREFIX = "revocation:";

/** authenticateの結果。失敗時はdocs/05 §3.1のエラー応答を返す */
type AuthnResult =
	| { ok: true; claims: AuthClaims }
	| { ok: false; result: ErrorResult };

/**
 * Authorizationヘッダを検証してクレームを返す(requireAuth系3ミドルウェアの本体)。
 * - ヘッダ欠落・「Bearer <token>」形式からの逸脱 → UNAUTHORIZED(docs/05 §3.1)
 * - 期限切れ → TOKEN_EXPIRED(クライアントは再ログインする)、それ以外の検証失敗 → UNAUTHORIZED
 * - KV失効リスト(revocation:{jti})存在時はUNAUTHORIZED(docs/04 §4・05 §2.3)
 */
const authenticate = async (
	env: Env,
	authorization: string | undefined,
): Promise<AuthnResult> => {
	if (authorization === undefined) {
		return {
			ok: false,
			result: errorJson("UNAUTHORIZED", "認証が必要です"),
		};
	}
	// 形式は「Bearer <token>」のみ(スキーマ名は大文字小文字込みで一致・トークン部は非空)
	const parts = authorization.split(" ");
	if (parts.length !== 2 || parts[0] !== "Bearer" || parts[1] === "") {
		return {
			ok: false,
			result: errorJson("UNAUTHORIZED", "認証ヘッダの形式が不正です"),
		};
	}
	let claims: AuthClaims;
	try {
		claims = await verifyAccessToken(jwtSecret(env), parts[1]);
	} catch (error) {
		if (error instanceof AccessTokenError && error.kind === "expired") {
			return {
				ok: false,
				result: errorJson(
					"TOKEN_EXPIRED",
					"アクセストークンの有効期限が切れています。再ログインしてください",
				),
			};
		}
		return {
			ok: false,
			result: errorJson("UNAUTHORIZED", "アクセストークンが不正です"),
		};
	}
	// KV失効リスト(docs/04 §4)。jtiが格納済みなら失効済み(ログアウト・ブロック・退会)
	const revoked = await env.REVOCATION_KV.get(
		`${REVOCATION_KV_PREFIX}${claims.jti}`,
	);
	if (revoked !== null) {
		return {
			ok: false,
			result: errorJson("UNAUTHORIZED", "アクセストークンは失効しています"),
		};
	}
	return { ok: true, claims };
};

/** 有効なBearer JWT必須。成功時はクレームをVariablesのauthに載せる(docs/05 §3.1) */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const result = await authenticate(c.env, c.req.header("Authorization"));
	if (!result.ok) {
		return c.json(result.result.body, result.result.status);
	}
	c.set("auth", result.claims);
	await next();
};

/** requireAuthの検証+登録済みユーザーのトークン(subあり)必須。無ければ401(docs/05 §3.1) */
export const requireRegistered: MiddlewareHandler<AppEnv> = async (c, next) => {
	const result = await authenticate(c.env, c.req.header("Authorization"));
	if (!result.ok) {
		return c.json(result.result.body, result.result.status);
	}
	c.set("auth", result.claims);
	if (result.claims.sub === undefined) {
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	await next();
};

/**
 * requireAuthの検証+登録前トークン必須(docs/04 §4・05 §2.3: 登録フロー途中のJWT)。
 * idpProvider/idpSubjectが存在しsubが無いこと。違反は401(docs/05 §3.1)
 */
export const requirePreRegistration: MiddlewareHandler<AppEnv> = async (
	c,
	next,
) => {
	const result = await authenticate(c.env, c.req.header("Authorization"));
	if (!result.ok) {
		return c.json(result.result.body, result.result.status);
	}
	c.set("auth", result.claims);
	const { idpProvider, idpSubject, sub } = result.claims;
	if (
		idpProvider === undefined ||
		idpSubject === undefined ||
		sub !== undefined
	) {
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録前のアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	await next();
};
