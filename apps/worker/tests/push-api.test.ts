/**
 * Web Push購読のAPI(GET vapid-public-key・POST/DELETE push-subscriptions)の統合試験(F7b設計 §4)。
 */
import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { pushSubscriptions } from "../src/db/schema";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";
import vapid from "./fixtures/test-vapid.json";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign((await importJWK(privateJwk, "RS256")) as CryptoKey);
};

interface Account {
	token: string;
	id: string;
}

const registerUser = async (label: string): Promise<Account> => {
	const tokenRes = await SELF.fetch("https://localhost/v1/auth/token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "google",
			idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
		}),
	});
	const pre = (await tokenRes.json()) as { access_token: string };
	const regRes = await SELF.fetch("https://localhost/v1/users", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${pre.access_token}`,
		},
		body: JSON.stringify({
			display_name: `${label}さん`,
			birth_date: "1990-01-01",
		}),
	});
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { token: body.access_token, id: body.user.id };
};

const call = (
	method: "GET" | "POST" | "DELETE",
	path: string,
	token: string | undefined,
	body?: unknown,
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** 正しい形の鍵(p256dh=0x04始まりの65バイト・auth=16バイト) */
const goodKeys = (seed = 1) => {
	const p = new Uint8Array(65).fill(seed);
	p[0] = 0x04;
	return { p256dh: b64url(p), auth: b64url(new Uint8Array(16).fill(seed)) };
};

const newEndpoint = () => `https://fcm.googleapis.com/fcm/send/${ulid()}`;

const rowsOf = (endpoint: string) =>
	db
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.endpoint, endpoint));

const reasonsOf = async (res: Response): Promise<string[]> => {
	const body = (await res.json()) as {
		error: { details?: { reasons?: string[] } };
	};
	return body.error.details?.reasons ?? [];
};

describe("Web Push購読のAPI", () => {
	it("公開鍵がVAPID fixtureと一致する", async () => {
		const u = await registerUser("pk");
		const res = await call("GET", "/v1/push/vapid-public-key", u.token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ public_key: vapid.publicKey });
	});

	it("新規は201・同じ要求は200で行は1つ", async () => {
		const u = await registerUser("new");
		const endpoint = newEndpoint();
		const body = { endpoint, keys: goodKeys() };
		expect(
			(await call("POST", "/v1/push-subscriptions", u.token, body)).status,
		).toBe(201);
		expect(
			(await call("POST", "/v1/push-subscriptions", u.token, body)).status,
		).toBe(200);
		const rows = await rowsOf(endpoint);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("active");
	});

	it("鍵の形が誤りなら400 invalid_push_keys", async () => {
		const u = await registerUser("keys");
		const bad65 = new Uint8Array(65).fill(2); // 先頭が0x04でない
		const short64 = new Uint8Array(64).fill(4);
		const cases = [
			{ p256dh: b64url(short64), auth: goodKeys().auth },
			{ p256dh: b64url(bad65), auth: goodKeys().auth },
			{ p256dh: goodKeys().p256dh, auth: b64url(new Uint8Array(15)) },
			{ p256dh: "!!!", auth: goodKeys().auth },
		];
		for (const keys of cases) {
			const res = await call("POST", "/v1/push-subscriptions", u.token, {
				endpoint: newEndpoint(),
				keys,
			});
			expect(res.status).toBe(400);
			expect(await reasonsOf(res)).toContain("invalid_push_keys");
		}
	});

	it("別ユーザーが同じendpointを登録すると付け替わり鍵が更新されactiveに戻る", async () => {
		const a = await registerUser("a");
		const b = await registerUser("b");
		const endpoint = newEndpoint();
		await call("POST", "/v1/push-subscriptions", a.token, {
			endpoint,
			keys: goodKeys(1),
		});
		await db
			.update(pushSubscriptions)
			.set({ status: "failed" })
			.where(eq(pushSubscriptions.endpoint, endpoint));
		const keys = goodKeys(7);
		await call("POST", "/v1/push-subscriptions", b.token, { endpoint, keys });
		const rows = await rowsOf(endpoint);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.userId).toBe(b.id);
		expect(rows[0]?.p256dh).toBe(keys.p256dh);
		expect(rows[0]?.auth).toBe(keys.auth);
		expect(rows[0]?.status).toBe("active");
	});

	it("active 10件の後の11件目は400 push_subscription_limit(failedは数えない)", async () => {
		const u = await registerUser("limit");
		for (let i = 0; i < 10; i++) {
			const res = await call("POST", "/v1/push-subscriptions", u.token, {
				endpoint: newEndpoint(),
				keys: goodKeys(),
			});
			expect(res.status).toBe(201);
		}
		const over = await call("POST", "/v1/push-subscriptions", u.token, {
			endpoint: newEndpoint(),
			keys: goodKeys(),
		});
		expect(over.status).toBe(400);
		expect(await reasonsOf(over)).toContain("push_subscription_limit");
		// 既存endpointの再登録は上限に掛からない
		const existing = (
			await db
				.select()
				.from(pushSubscriptions)
				.where(eq(pushSubscriptions.userId, u.id))
		)[0];
		expect(existing).toBeDefined();
		const again = await call("POST", "/v1/push-subscriptions", u.token, {
			endpoint: existing?.endpoint,
			keys: goodKeys(),
		});
		expect(again.status).toBe(200);
		// failedにすれば1件空く
		await db
			.update(pushSubscriptions)
			.set({ status: "failed" })
			.where(eq(pushSubscriptions.id, existing?.id ?? ""));
		const ok = await call("POST", "/v1/push-subscriptions", u.token, {
			endpoint: newEndpoint(),
			keys: goodKeys(),
		});
		expect(ok.status).toBe(201);
	});

	it("許可外ホストは400 push_endpoint_not_allowed", async () => {
		const u = await registerUser("host");
		const res = await call("POST", "/v1/push-subscriptions", u.token, {
			endpoint: "https://evil.example/push/abc",
			keys: goodKeys(),
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toContain("push_endpoint_not_allowed");
	});

	it("DELETEは本人の行だけ消し、再実行・他人のendpointも204", async () => {
		const a = await registerUser("da");
		const b = await registerUser("db");
		const ea = newEndpoint();
		const eb = newEndpoint();
		await call("POST", "/v1/push-subscriptions", a.token, {
			endpoint: ea,
			keys: goodKeys(),
		});
		await call("POST", "/v1/push-subscriptions", b.token, {
			endpoint: eb,
			keys: goodKeys(),
		});
		expect(
			(
				await call("DELETE", "/v1/push-subscriptions", a.token, {
					endpoint: ea,
				})
			).status,
		).toBe(204);
		expect(await rowsOf(ea)).toHaveLength(0);
		expect(
			(
				await call("DELETE", "/v1/push-subscriptions", a.token, {
					endpoint: ea,
				})
			).status,
		).toBe(204);
		expect(
			(
				await call("DELETE", "/v1/push-subscriptions", a.token, {
					endpoint: eb,
				})
			).status,
		).toBe(204);
		expect(await rowsOf(eb)).toHaveLength(1);
	});

	it("未登録トークンは401", async () => {
		const tokenRes = await SELF.fetch("https://localhost/v1/auth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "google",
				idp_token: await signIdpToken(`pre-${crypto.randomUUID()}`),
			}),
		});
		const pre = (await tokenRes.json()) as { access_token: string };
		expect(
			(await call("GET", "/v1/push/vapid-public-key", pre.access_token)).status,
		).toBe(401);
		expect(
			(
				await call("POST", "/v1/push-subscriptions", pre.access_token, {
					endpoint: newEndpoint(),
					keys: goodKeys(),
				})
			).status,
		).toBe(401);
		expect(
			(await call("GET", "/v1/push/vapid-public-key", undefined)).status,
		).toBe(401);
	});
});
