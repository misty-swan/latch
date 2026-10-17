/**
 * アクセストークンJWTの単体試験(docs/04 §4: 独自JWT・有効期限1時間)。
 * バインディングに依存しない純粋な単体試験のため、cloudflare:testは使わない(env.test.tsと同じ方針)。
 * 時刻はfixedClockで固定する(docs/04 §4の時刻の規律)。
 */

import type { AuthProvider } from "@latch/shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock/clock";
import { newUlid } from "../ids";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	type AccessClaims,
	AccessTokenError,
	signAccessToken,
	verifyAccessToken,
} from "./jwt";

/** 単体試験用の署名鍵(HS256は32字以上の鍵を要求するため十分な長さを確保) */
const SECRET = "unit-test-jwt-secret-0123456789abcdef";

/**
 * jtiの生成はcrypto.randomUUID()(Workers/Web標準・docs/04 §4の失効リスト用トークンID)。
 * ユーザーID等のULIDはnewUlid()を使う
 */
const newJti = (): string => crypto.randomUUID();

/** base64urlをデコードする(ペイロードのワイヤ形式検証・改ざん用) */
const b64urlDecode = (s: string): string =>
	atob(
		s.replaceAll("-", "+").replaceAll("_", "/") +
			"==".slice((s.length + 2) % 4),
	);

/** base64urlへエンコードする(改ざんペイロードの再構築用) */
const b64urlEncode = (s: string): string =>
	btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** JWTのペイロード部をJSONとして取り出す */
const payloadOf = (token: string): Record<string, unknown> =>
	JSON.parse(b64urlDecode(token.split(".")[1] ?? "")) as Record<
		string,
		unknown
	>;

const makeClaims = (overrides: Partial<AccessClaims> = {}): AccessClaims => ({
	jti: newJti(),
	sub: newUlid(),
	idpProvider: "google" satisfies AuthProvider,
	idpSubject: "idp-subject-123",
	...overrides,
});

describe("signAccessToken→verifyAccessToken(docs/04 §4: アクセストークン1時間)", () => {
	it("jti・sub・idpProvider/idpSubjectが往復する", async () => {
		const claims = makeClaims();
		const token = await signAccessToken(SECRET, fixedClock(new Date()), claims);
		const verified = await verifyAccessToken(SECRET, token);
		expect(verified.jti).toBe(claims.jti);
		expect(verified.sub).toBe(claims.sub);
		expect(verified.idpProvider).toBe("google");
		expect(verified.idpSubject).toBe(claims.idpSubject);
	});

	it("ワイヤ形式はiss=latch・カスタムクレームはidp_provider/idp_subject(snake_case)", async () => {
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date()),
			makeClaims(),
		);
		const payload = payloadOf(token);
		expect(payload.iss).toBe("latch");
		expect(payload.idp_provider).toBe("google");
		expect(payload.idp_subject).toBe("idp-subject-123");
		expect(payload).not.toHaveProperty("idpProvider");
		expect(payload).not.toHaveProperty("idpSubject");
	});

	it("expはclock+3600秒(ACCESS_TOKEN_TTL_SECONDS)", async () => {
		expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
		const issuedAtMs = Date.parse("2026-10-18T00:00:00.000Z");
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date(issuedAtMs)),
			makeClaims(),
		);
		const verified = await verifyAccessToken(SECRET, token);
		expect(verified.exp).toBe(Math.floor(issuedAtMs / 1000) + 3600);
	});

	it("iatはclockの時刻(joseの既定の実時間を使わない)", async () => {
		const issuedAtMs = Date.parse("2026-10-18T00:00:00.000Z");
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date(issuedAtMs)),
			makeClaims(),
		);
		expect(payloadOf(token).iat).toBe(Math.floor(issuedAtMs / 1000));
	});
});

describe("verifyAccessTokenの失敗(docs/05 §3.1: TOKEN_EXPIRED/UNAUTHORIZEDへの分岐元)", () => {
	it("別secretでのverifyはAccessTokenError(kind=invalid)", async () => {
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date()),
			makeClaims(),
		);
		let caught: unknown;
		try {
			await verifyAccessToken(`${SECRET}-wrong`, token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AccessTokenError);
		expect((caught as AccessTokenError).kind).toBe("invalid");
	});

	it("改ざんペイロードはAccessTokenError(kind=invalid)", async () => {
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date()),
			makeClaims(),
		);
		const [header, , signature] = token.split(".");
		const tampered = payloadOf(token);
		tampered.sub = newUlid();
		const forgedToken = `${header}.${b64urlEncode(JSON.stringify(tampered))}.${signature}`;
		let caught: unknown;
		try {
			await verifyAccessToken(SECRET, forgedToken);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AccessTokenError);
		expect((caught as AccessTokenError).kind).toBe("invalid");
	});

	it("形式不正な文字列はAccessTokenError(kind=invalid)", async () => {
		let caught: unknown;
		try {
			await verifyAccessToken(SECRET, "not-a-jwt");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AccessTokenError);
		expect((caught as AccessTokenError).kind).toBe("invalid");
	});

	it("idp_providerが未知の値はAccessTokenError(kind=invalid・型だけを信用しない実行時検査)", async () => {
		// signAccessTokenはAuthProvider型しか受けないため、未知の値を持つ
		// トークンを直接署名して作る(改ざんや将来の形式変化への防御の試験)
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({
			jti: newJti(),
			idp_provider: "unknown",
		})
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt(now)
			.setIssuer("latch")
			.setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
			.sign(new TextEncoder().encode(SECRET));
		let caught: unknown;
		try {
			await verifyAccessToken(SECRET, token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AccessTokenError);
		expect((caught as AccessTokenError).kind).toBe("invalid");
	});

	it("発行時刻を実現在より7200秒前としたtokenは期限切れ(joseのERR_JWT_EXPIRED→kind=expired)", async () => {
		// joseの検証は実現在基準でexpを見るため、過去時刻のclockで署名して
		// expが既に過ぎたtokenを作ることで期限切れを決定的に再現する
		const pastMs = Date.now() - 7200 * 1000;
		const token = await signAccessToken(
			SECRET,
			fixedClock(new Date(pastMs)),
			makeClaims(),
		);
		let caught: unknown;
		try {
			await verifyAccessToken(SECRET, token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AccessTokenError);
		expect((caught as AccessTokenError).kind).toBe("expired");
	});
});

describe("sub無し(登録前JWT・docs/04 §4: 登録フロー途中のトークン)", () => {
	it("sub無しでも署名・検証できる", async () => {
		const claims = makeClaims({
			sub: undefined,
			idpProvider: undefined,
			idpSubject: undefined,
		});
		const token = await signAccessToken(SECRET, fixedClock(new Date()), claims);
		const verified = await verifyAccessToken(SECRET, token);
		expect(verified.jti).toBe(claims.jti);
		expect(verified.sub).toBeUndefined();
		expect(verified.idpProvider).toBeUndefined();
		expect(verified.idpSubject).toBeUndefined();
	});
});
