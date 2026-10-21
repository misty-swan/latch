/**
 * VAPID(RFC 8292)の認可ヘッダの単体試験(F7b設計 §5.3)。
 */

import {
	base64url,
	exportJWK,
	generateKeyPair,
	importJWK,
	jwtVerify,
} from "jose";
import { describe, expect, it } from "vitest";
import { type VapidKeys, vapidAuthorization } from "./vapid";

async function makeKeys(): Promise<{ keys: VapidKeys; pub: JsonWebKey }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256", {
		extractable: true,
	});
	const priv = await exportJWK(privateKey);
	const pub = await exportJWK(publicKey);
	const raw = new Uint8Array(65);
	raw[0] = 4;
	raw.set(base64url.decode(pub.x as string), 1);
	raw.set(base64url.decode(pub.y as string), 33);
	return {
		keys: {
			publicKey: base64url.encode(raw),
			privateJwk: priv as JsonWebKey,
			subject: "mailto:ops@example.com",
		},
		pub: pub as JsonWebKey,
	};
}

describe("vapidAuthorization", () => {
	it("ES256のJWTが検証でき、aud・exp・subが仕様どおり", async () => {
		const { keys, pub } = await makeKeys();
		const now = new Date("2026-10-21T00:00:00Z");
		const header = await vapidAuthorization(
			"https://fcm.googleapis.com/fcm/send/x",
			keys,
			now,
		);
		expect(header.startsWith("vapid t=")).toBe(true);
		expect(header).toContain(`, k=${keys.publicKey}`);
		const jwt = header.slice("vapid t=".length, header.indexOf(", k="));
		const { payload } = await jwtVerify(jwt, await importJWK(pub, "ES256"), {
			currentDate: now,
		});
		expect(payload.aud).toBe("https://fcm.googleapis.com");
		expect(payload.sub).toBe("mailto:ops@example.com");
		expect(
			(payload.exp as number) - (payload.iat as number),
		).toBeLessThanOrEqual(86_400);
		expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 3600);
	});
});
