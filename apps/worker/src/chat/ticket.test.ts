/**
 * WebSocket接続チケットの単体試験(F6a設計 §3.5)。
 * 時刻はfixedClockで固定する(docs/04 §4)。joseの期限検証は実時間基準のため、
 * 期限切れは過去時刻のClockで発行して再現する。
 */

import { CHAT } from "@latch/shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { signAccessToken } from "../auth/jwt";
import { fixedClock } from "../clock/clock";
import { newUlid } from "../ids";
import { issueChatTicket, verifyChatTicket } from "./ticket";

const SECRET = "unit-test-jwt-secret-0123456789abcdef";

const b64urlDecode = (s: string): string =>
	atob(
		s.replaceAll("-", "+").replaceAll("_", "/") +
			"==".slice((s.length + 2) % 4),
	);

describe("issueChatTicket→verifyChatTicket", () => {
	it("userId・latchId・jtiが戻り、exp=iat+60秒", async () => {
		const clock = fixedClock(new Date());
		const userId = newUlid();
		const latchId = newUlid();
		const { ticket, expiresIn } = await issueChatTicket(SECRET, clock, {
			userId,
			latchId,
		});
		expect(expiresIn).toBe(CHAT.WS_TICKET_TTL_SECONDS);
		const claims = await verifyChatTicket(SECRET, ticket);
		expect(claims).not.toBeNull();
		expect(claims?.userId).toBe(userId);
		expect(claims?.latchId).toBe(latchId);
		expect(claims?.jti).toMatch(/^[0-9A-Z]{26}$/);
		expect(claims?.exp).toBe(Math.floor(clock.now().getTime() / 1000) + 60);
	});

	it("61秒前の時刻で発行したチケットはnull(期限切れ)", async () => {
		const clock = fixedClock(new Date(Date.now() - 61 * 1000));
		const { ticket } = await issueChatTicket(SECRET, clock, {
			userId: newUlid(),
			latchId: newUlid(),
		});
		expect(await verifyChatTicket(SECRET, ticket)).toBeNull();
	});

	it("別の鍵で検証するとnull", async () => {
		const { ticket } = await issueChatTicket(SECRET, fixedClock(new Date()), {
			userId: newUlid(),
			latchId: newUlid(),
		});
		expect(await verifyChatTicket(`${SECRET}-wrong`, ticket)).toBeNull();
	});

	it("アクセストークンはチケットとして通らない", async () => {
		const token = await signAccessToken(SECRET, fixedClock(new Date()), {
			jti: crypto.randomUUID(),
			sub: newUlid(),
		});
		expect(await verifyChatTicket(SECRET, token)).toBeNull();
	});

	it("ペイロードを1文字置換した改ざんはnull", async () => {
		const { ticket } = await issueChatTicket(SECRET, fixedClock(new Date()), {
			userId: newUlid(),
			latchId: newUlid(),
		});
		const [header, payload, signature] = ticket.split(".") as [
			string,
			string,
			string,
		];
		const swapped = payload.startsWith("A") ? "B" : "A";
		const forged = `${header}.${swapped}${payload.slice(1)}.${signature}`;
		expect(await verifyChatTicket(SECRET, forged)).toBeNull();
	});

	it("ワイヤ形式はiss=latch・typ=ws_ticket・latch_idを持つ", async () => {
		const latchId = newUlid();
		const { ticket } = await issueChatTicket(SECRET, fixedClock(new Date()), {
			userId: newUlid(),
			latchId,
		});
		const payload = JSON.parse(b64urlDecode(ticket.split(".")[1] ?? ""));
		expect(payload.iss).toBe("latch");
		expect(payload.typ).toBe("ws_ticket");
		expect(payload.latch_id).toBe(latchId);
	});

	it("typが無い・latch_idが欠けた署名済みトークンはnull", async () => {
		const now = Math.floor(Date.now() / 1000);
		const key = new TextEncoder().encode(SECRET);
		const base = (claims: Record<string, unknown>) =>
			new SignJWT(claims)
				.setProtectedHeader({ alg: "HS256" })
				.setIssuedAt(now)
				.setIssuer("latch")
				.setExpirationTime(now + 60)
				.sign(key);
		const noTyp = await base({ sub: newUlid(), latch_id: newUlid(), jti: "x" });
		const noLatch = await base({ sub: newUlid(), typ: "ws_ticket", jti: "x" });
		expect(await verifyChatTicket(SECRET, noTyp)).toBeNull();
		expect(await verifyChatTicket(SECRET, noLatch)).toBeNull();
	});
});
