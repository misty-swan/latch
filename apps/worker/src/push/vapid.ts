/**
 * VAPID(RFC 8292)の認可ヘッダ(F7b設計 §5.3)。ES256のJWTを都度署名する。
 */

import { importJWK, SignJWT } from "jose";

export interface VapidKeys {
	/** base64url・非圧縮点の65バイト */
	publicKey: string;
	privateJwk: JsonWebKey;
	subject: string;
}

/** F7b設計 §5.3: exp は署名時刻の12時間後(RFC 8292 §2 の上限24時間以内) */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	now: Date,
): Promise<string> {
	const key = await importJWK(keys.privateJwk as never, "ES256");
	const iat = Math.floor(now.getTime() / 1000);
	const jwt = await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", typ: "JWT" })
		.setAudience(new URL(endpoint).origin)
		.setSubject(keys.subject)
		.setIssuedAt(iat)
		.setExpirationTime(iat + VAPID_TTL_SECONDS)
		.sign(key);
	return `vapid t=${jwt}, k=${keys.publicKey}`;
}
