import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertEnvSafety, type Env } from "../env";
import { resetAccessKeyCacheForTest, verifyAccessRequest } from "./access";

// 試験用の架空の値(実在のチーム名・AUDは書かない)
const TEAM = "https://fake-team.cloudflareaccess.com";
const AUD = "fake-aud-0123456789";

interface TestKey {
	privateKey: CryptoKey;
	jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

const makeKey = async (kid: string): Promise<TestKey> => {
	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk = {
		...(await exportJWK(publicKey)),
		kid,
		alg: "RS256",
		use: "sig",
	};
	return { privateKey, jwk } as TestKey;
};

const sign = (
	key: TestKey,
	opts: { iss?: string; aud?: string | string[]; exp?: string | number } = {},
) =>
	new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: key.jwk.kid })
		.setIssuer(opts.iss ?? TEAM)
		.setAudience(opts.aud ?? [AUD])
		.setIssuedAt()
		.setExpirationTime(opts.exp ?? "5m")
		.sign(key.privateKey);

const jwksFetch = (...keys: TestKey[]) =>
	vi.fn(async (_input: RequestInfo | URL) =>
		Response.json({ keys: keys.map((k) => k.jwk) }),
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const req = (token?: string) =>
	new Request("https://example.test/healthz", {
		headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token },
	});

const env = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM } as unknown as Env;

describe("verifyAccessRequest", () => {
	beforeEach(() => resetAccessKeyCacheForTest());

	it("ヘッダー無しはmissing", async () => {
		const f = jwksFetch();
		expect(await verifyAccessRequest(req(), env, f)).toEqual({
			ok: false,
			reason: "missing",
		});
	});

	it("正しい証明はok", async () => {
		const key = await makeKey("k1");
		const f = jwksFetch(key);
		expect(await verifyAccessRequest(req(await sign(key)), env, f)).toEqual({
			ok: true,
		});
		expect(f).toHaveBeenCalledWith(`${TEAM}/cdn-cgi/access/certs`);
	});

	it("aud違い・iss違い・期限切れ・別の鍵の署名はinvalid", async () => {
		const key = await makeKey("k1");
		const other = await makeKey("k1");
		const f = jwksFetch(key);
		const bad = [
			await sign(key, { aud: ["other"] }),
			await sign(key, { iss: "https://evil.cloudflareaccess.com" }),
			await sign(key, { exp: Math.floor(Date.now() / 1000) - 60 }),
			await sign(other),
		];
		for (const token of bad) {
			expect(await verifyAccessRequest(req(token), env, f)).toEqual({
				ok: false,
				reason: "invalid",
			});
		}
	});

	it("JWKSの取得が500ならjwks_unavailable", async () => {
		const key = await makeKey("k1");
		const f = vi.fn(
			async () => new Response("x", { status: 500 }),
		) as unknown as typeof fetch;
		expect(await verifyAccessRequest(req(await sign(key)), env, f)).toEqual({
			ok: false,
			reason: "jwks_unavailable",
		});
	});

	it("同じkidならfetchを呼ばず、未知のkidなら1回だけ取り直す", async () => {
		const k1 = await makeKey("k1");
		const k2 = await makeKey("k2");
		const f = jwksFetch(k1);
		await verifyAccessRequest(req(await sign(k1)), env, f);
		await verifyAccessRequest(req(await sign(k1)), env, f);
		expect(f).toHaveBeenCalledTimes(1);
		const f2 = jwksFetch(k1, k2);
		const r = await verifyAccessRequest(req(await sign(k2)), env, f2);
		expect(r).toEqual({ ok: true });
		expect(f2).toHaveBeenCalledTimes(1);
		// 取り直しても無いkidはinvalid(取り直しは1回)
		const k3 = await makeKey("k3");
		const f3 = jwksFetch(k1, k2);
		expect(await verifyAccessRequest(req(await sign(k3)), env, f3)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(f3).toHaveBeenCalledTimes(1);
	});
});

describe("assertEnvSafety(staging)", () => {
	const base = { LATCH_ENV: "staging" } as unknown as Env;
	it("stagingでACCESS_*が欠けると例外", () => {
		expect(() => assertEnvSafety(base)).toThrow(/^ENV_MISSING_ACCESS/);
		expect(() => assertEnvSafety({ ...base, ACCESS_AUD: AUD } as Env)).toThrow(
			/^ENV_MISSING_ACCESS/,
		);
		expect(() =>
			assertEnvSafety({ ...base, ACCESS_TEAM_DOMAIN: TEAM } as Env),
		).toThrow(/^ENV_MISSING_ACCESS/);
	});
	it("stagingで両方あれば例外なし・localは例外なし", () => {
		expect(() =>
			assertEnvSafety({
				...base,
				ACCESS_AUD: AUD,
				ACCESS_TEAM_DOMAIN: TEAM,
			} as Env),
		).not.toThrow();
		expect(() =>
			assertEnvSafety({ LATCH_ENV: "local" } as unknown as Env),
		).not.toThrow();
	});
});
