/**
 * RFC 8291 §5 の試験ベクトルによる暗号化の単体試験(F7b設計 §5.3)。
 */

import { base64url } from "jose";
import { describe, expect, it } from "vitest";
import { encryptAes128gcm } from "./encrypt";

// RFC 8291 §5 / 付録A の値(原文のまま)
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const UA_PUBLIC =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const EXPECTED =
	"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
	"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
	"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

async function rfcAsKeyPair(): Promise<CryptoKeyPair> {
	const pub = base64url.decode(AS_PUBLIC);
	const x = base64url.encode(pub.slice(1, 33));
	const y = base64url.encode(pub.slice(33, 65));
	const algo = { name: "ECDH", namedCurve: "P-256" };
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", d: AS_PRIVATE, x, y },
		algo,
		true,
		["deriveBits"],
	);
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", x, y },
		algo,
		true,
		[],
	);
	return { privateKey, publicKey };
}

describe("encryptAes128gcm", () => {
	it("RFC 8291 §5 の本文と完全一致する", async () => {
		const out = await encryptAes128gcm(
			new TextEncoder().encode(PLAINTEXT),
			base64url.decode(UA_PUBLIC),
			base64url.decode(AUTH_SECRET),
			{ salt: base64url.decode(SALT), asKeyPair: await rfcAsKeyPair() },
		);
		expect(base64url.encode(out)).toBe(EXPECTED.replace(/\s/g, ""));
	});

	it("inject無しではsaltと鍵対が毎回変わり、ヘッダは86バイトの形になる", async () => {
		const run = () =>
			encryptAes128gcm(
				new TextEncoder().encode("x"),
				base64url.decode(UA_PUBLIC),
				base64url.decode(AUTH_SECRET),
			);
		const a = await run();
		const b = await run();
		expect(base64url.encode(a)).not.toBe(base64url.encode(b));
		expect(a.length).toBe(86 + 1 + 1 + 16);
		expect(a[16]).toBe(0);
		expect(a[17]).toBe(0);
		expect(a[18]).toBe(0x10);
		expect(a[19]).toBe(0);
		expect(a[20]).toBe(65);
		expect(a[21]).toBe(0x04);
	});
});
