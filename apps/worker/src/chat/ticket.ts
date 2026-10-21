/**
 * WebSocket接続チケット(F6a設計 §3.5)。ブラウザのWebSocketはAuthorizationヘッダを付けられないため、
 * 認証済みのPOSTで60秒有効のチケットを発行し、接続URLのクエリで渡す。1回限りの記録(jtiの使用済み)はChatRoomDOが担う。
 * HS256・iss="latch"・typ="ws_ticket"で、アクセストークンとは相互に通らない
 * (verifyAccessTokenはtypを持つトークンを拒否し、本検証はtyp一致を要求する)。
 * 時刻の規律(docs/04 §4): 発行時刻はClock引数でのみ受け取る。
 */

import { CHAT } from "@latch/shared";
import { jwtVerify, SignJWT } from "jose";
import { JWT_ISSUER } from "../auth/jwt";
import type { Clock } from "../clock/clock";
import { newUlid } from "../ids";

/** チケットのtypクレーム値 */
const TICKET_TYP = "ws_ticket";

/** 検証済みチケットのクレーム。expはUNIX秒 */
export interface ChatTicketClaims {
	userId: string;
	latchId: string;
	jti: string;
	exp: number;
}

/** チケットを発行する(exp=発行時刻+60秒) */
export const issueChatTicket = async (
	secret: string,
	clock: Clock,
	input: { userId: string; latchId: string },
): Promise<{ ticket: string; expiresIn: 60 }> => {
	const iat = Math.floor(clock.now().getTime() / 1000);
	const ticket = await new SignJWT({
		typ: TICKET_TYP,
		latch_id: input.latchId,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(input.userId)
		.setJti(newUlid())
		.setIssuedAt(iat)
		.setIssuer(JWT_ISSUER)
		.setExpirationTime(iat + CHAT.WS_TICKET_TTL_SECONDS)
		.sign(new TextEncoder().encode(secret));
	return { ticket, expiresIn: CHAT.WS_TICKET_TTL_SECONDS };
};

/** チケットを検証する。どの理由で失敗してもnull(理由を区別しない・F6a設計 §3.5) */
export const verifyChatTicket = async (
	secret: string,
	token: string,
): Promise<ChatTicketClaims | null> => {
	try {
		const { payload } = await jwtVerify(
			token,
			new TextEncoder().encode(secret),
			{ issuer: JWT_ISSUER, algorithms: ["HS256"] },
		);
		const { sub, jti, exp, typ } = payload;
		const latchId = payload.latch_id;
		if (
			typ !== TICKET_TYP ||
			typeof sub !== "string" ||
			typeof latchId !== "string" ||
			typeof jti !== "string" ||
			typeof exp !== "number"
		) {
			return null;
		}
		return { userId: sub, latchId, jti, exp };
	} catch {
		return null;
	}
};
