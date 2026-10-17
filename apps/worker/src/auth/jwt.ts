/**
 * アクセストークンJWT(HS256・有効期限1時間=docs/04 §4)の署名と検証。
 * 登録フロー途中はsubを持たない登録前JWTを発行する(docs/04 §4・05 §2.3)。
 * 時刻の規律(docs/04 §4): 実時間を直接参照しないため、このモジュールはsystemClockを
 * importせず、署名時の現在時刻は引数のclock経由でのみ受け取る。
 */

import type { AuthProvider } from "@latch/shared";
import type { JWTPayload } from "jose";
import { jwtVerify, SignJWT } from "jose";
import type { Clock } from "../clock/clock";

/** アクセストークンの有効期限(秒)。docs/04 §4: 独自JWT(有効期限1時間) */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** アクセストークンのJWT issuer(docs/04 §4: LATCHが発行する独自JWT) */
const JWT_ISSUER = "latch";

/** アクセストークンのクレーム。idpProvider/idpSubjectはワイヤ上ではidp_provider/idp_subject(snake_case) */
export interface AccessClaims {
	/** トークンID。KVの失効リスト(docs/04 §4: jtiをTTL=残り寿命で格納)用。値はcrypto.randomUUID()で採番する */
	jti: string;
	/** ユーザーID。登録前JWTでは未設定 */
	sub?: string;
	/** 認証プロバイダ(docs/05 §2.2: users.auth_provider) */
	idpProvider?: AuthProvider;
	/** IdP側のサブジェクト */
	idpSubject?: string;
}

/** アクセストークン検証の失敗。kind: "expired"=期限切れ / "invalid"=それ以外(署名不一致・形式不正等) */
export class AccessTokenError extends Error {
	kind: "expired" | "invalid";

	constructor(kind: "expired" | "invalid", message: string) {
		super(message);
		this.name = "AccessTokenError";
		this.kind = kind;
	}
}

/** カスタムクレームのワイヤ名(TSの型はcamelCase・JWT上はsnake_case) */
const WIRE_IDP_PROVIDER = "idp_provider";
const WIRE_IDP_SUBJECT = "idp_subject";

/**
 * アクセストークンを署名する(HS256・iss="latch"・iat=署名時刻・exp=iat+3600秒)。
 * clockは呼び出し側から注入する(docs/04 §4の時刻の規律)
 */
export const signAccessToken = async (
	secret: string,
	clock: Clock,
	claims: AccessClaims,
): Promise<string> => {
	const iat = Math.floor(clock.now().getTime() / 1000);
	const wireClaims: JWTPayload = { jti: claims.jti };
	if (claims.sub !== undefined) {
		wireClaims.sub = claims.sub;
	}
	if (claims.idpProvider !== undefined) {
		wireClaims[WIRE_IDP_PROVIDER] = claims.idpProvider;
	}
	if (claims.idpSubject !== undefined) {
		wireClaims[WIRE_IDP_SUBJECT] = claims.idpSubject;
	}
	return new SignJWT(wireClaims)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt(iat)
		.setIssuer(JWT_ISSUER)
		.setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
		.sign(new TextEncoder().encode(secret));
};

/**
 * アクセストークンを検証してクレームを返す(iss・alg・署名・期限をjoseが検証)。
 * 失敗はAccessTokenError。期限切れ(クライアントの再ログイン要求・docs/05 §3.1のTOKEN_EXPIRED
 * への分岐元)のみkind="expired"、それ以外はkind="invalid"
 */
export const verifyAccessToken = async (
	secret: string,
	token: string,
): Promise<AccessClaims & { exp: number }> => {
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
			issuer: JWT_ISSUER,
			algorithms: ["HS256"],
		}));
	} catch (error) {
		// 期限切れとそれ以外をjoseの例外コードで分岐する
		const kind =
			error instanceof Error &&
			"code" in error &&
			error.code === "ERR_JWT_EXPIRED"
				? "expired"
				: "invalid";
		throw new AccessTokenError(
			kind,
			kind === "expired"
				? "TOKEN_EXPIRED: アクセストークンの有効期限が切れている(docs/05 §3.1)"
				: "TOKEN_INVALID: アクセストークンが不正(docs/05 §3.1のUNAUTHORIZED)",
		);
	}
	if (typeof payload.jti !== "string") {
		throw new AccessTokenError(
			"invalid",
			"TOKEN_INVALID: jtiが欠落している(docs/04 §4の失効リストに必須)",
		);
	}
	if (typeof payload.exp !== "number") {
		throw new AccessTokenError("invalid", "TOKEN_INVALID: expが欠落している");
	}
	const verified: AccessClaims & { exp: number } = {
		jti: payload.jti,
		exp: payload.exp,
	};
	if (typeof payload.sub === "string") {
		verified.sub = payload.sub;
	}
	const idpProvider = payload[WIRE_IDP_PROVIDER];
	if (typeof idpProvider === "string") {
		verified.idpProvider = idpProvider as AuthProvider;
	}
	const idpSubject = payload[WIRE_IDP_SUBJECT];
	if (typeof idpSubject === "string") {
		verified.idpSubject = idpSubject;
	}
	return verified;
};
