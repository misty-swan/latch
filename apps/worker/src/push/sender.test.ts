/**
 * realPushSenderの単体試験(F7b設計 §5.2・§5.4)。fetchは注入した試験実装。
 */
import { describe, expect, it } from "vitest";
import testVapid from "../../tests/fixtures/test-vapid.json";
import { realPushSender } from "./sender";

const keys = {
	publicKey: testVapid.publicKey,
	privateJwk: testVapid.privateJwk as JsonWebKey,
	subject: "mailto:dev@latch.invalid",
};

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

const makeTarget = async () => {
	const kp = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const raw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
	);
	return {
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		p256dh: b64u(raw),
		auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
	};
};

describe("realPushSender", () => {
	it("必要なヘッダと暗号化本文でPOSTする", async () => {
		const target = await makeTarget();
		let seen: { url: string; init: RequestInit } | undefined;
		const sender = realPushSender(keys, (async (url, init) => {
			seen = { url: String(url), init: init as RequestInit };
			return new Response(null, { status: 201 });
		}) as typeof fetch);
		const r = await sender.send(target, '{"type":"proposal"}', {
			ttl: 600,
			urgency: "high",
		});
		expect(r).toEqual({ kind: "ok" });
		expect(seen?.url).toBe(target.endpoint);
		expect(seen?.init.method).toBe("POST");
		const h = new Headers(seen?.init.headers);
		expect(h.get("content-encoding")).toBe("aes128gcm");
		expect(h.get("content-type")).toBe("application/octet-stream");
		expect(h.get("ttl")).toBe("600");
		expect(h.get("urgency")).toBe("high");
		expect(h.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
		expect(
			(seen?.init.body as Uint8Array | undefined)?.byteLength,
		).toBeGreaterThan(86);
		// リダイレクトを追わず、時間制限のsignalを付ける
		expect(seen?.init.redirect).toBe("manual");
		expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		[200, { kind: "ok" }],
		[201, { kind: "ok" }],
		[404, { kind: "gone" }],
		[410, { kind: "gone" }],
		[301, { kind: "rejected", status: 301 }],
		[302, { kind: "rejected", status: 302 }],
		[400, { kind: "rejected", status: 400 }],
		[403, { kind: "rejected", status: 403 }],
		[413, { kind: "rejected", status: 413 }],
		[429, { kind: "retry", status: 429 }],
		[500, { kind: "retry", status: 500 }],
		[503, { kind: "retry", status: 503 }],
	])("HTTP %i を写像する", async (status, expected) => {
		const target = await makeTarget();
		const sender = realPushSender(
			keys,
			(async () => new Response(null, { status })) as typeof fetch,
		);
		expect(
			await sender.send(target, "x", { ttl: 60, urgency: "high" }),
		).toEqual(expected);
	});

	it("例外はretry(status null)", async () => {
		const target = await makeTarget();
		const sender = realPushSender(keys, (async () => {
			throw new Error("network");
		}) as typeof fetch);
		expect(
			await sender.send(target, "x", { ttl: 60, urgency: "high" }),
		).toEqual({ kind: "retry", status: null });
	});

	it("時間切れ(abort)はretry(status null)", async () => {
		const target = await makeTarget();
		const sender = realPushSender(keys, (async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as typeof fetch);
		expect(
			await sender.send(target, "x", { ttl: 60, urgency: "high" }),
		).toEqual({ kind: "retry", status: null });
	});

	it("中断されたfetch(AbortError)もretry", async () => {
		const target = await makeTarget();
		const sender = realPushSender(keys, (async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as typeof fetch);
		expect(
			await sender.send(target, "x", { ttl: 60, urgency: "high" }),
		).toEqual({ kind: "retry", status: null });
	});
});
