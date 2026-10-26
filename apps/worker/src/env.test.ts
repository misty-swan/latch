import { describe, expect, it } from "vitest";
import testVapidText from "../tests/fixtures/test-vapid.json?raw";
import {
	assertEnvSafety,
	DEV_FALLBACK_JWT_SECRET,
	type Env,
	jwtSecret,
	TEST_VAPID_PUBLIC_KEY,
	vapidKeysOf,
} from "./env";

// assertEnvSafety/jwtSecretはバインディング(DB等)を参照しないため、変数のみ与えるヘルパー
/** 60req/分のバインディング(prodで必須・docs/04 §5)。既定で入れ、欠落の試験だけ外す */
const RATE_LIMITER = {
	limit: async () => ({ success: true }),
} as unknown as RateLimit;

const makeEnv = (overrides: Partial<Env> = {}): Env =>
	({ API_RATE_LIMITER: RATE_LIMITER, ...overrides }) as unknown as Env;

const SECRET_32 = "a".repeat(32);

// prodの正常系に必要なWeb Push設定(F7b設計 §5.5)。公開鍵はテスト鍵と異なる値
const PUSH_OK = {
	LATCH_PUSH_MODE: "real",
	VAPID_PUBLIC_KEY: "B".repeat(87),
	VAPID_PRIVATE_KEY: "{}",
	VAPID_SUBJECT: "mailto:ops@latch.app",
} satisfies Partial<Env>;

describe("assertEnvSafety(docs/04 §4・docs/10 §2: prodテスト鍵起動ガード)", () => {
	it("prod+32字のJWT_SECRETは通る", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					...PUSH_OK,
				}),
			),
		).not.toThrow();
	});

	it("prodでLATCH_PUSH_MODEがreal以外は例外(ENV_UNSAFE_PUSH)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					...PUSH_OK,
					LATCH_PUSH_MODE: "stub",
				}),
			),
		).toThrow("ENV_UNSAFE_PUSH");
	});

	it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const)(
		"prodで%sが欠けると例外(ENV_MISSING_VAPID)",
		(key) => {
			const env = makeEnv({
				LATCH_ENV: "production",
				JWT_SECRET: SECRET_32,
				...PUSH_OK,
			});
			delete env[key];
			expect(() => assertEnvSafety(env)).toThrow("ENV_MISSING_VAPID");
		},
	);

	it("prodでVAPID_PUBLIC_KEYがテスト鍵だと例外(ENV_UNSAFE_TEST_KEY)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					...PUSH_OK,
					VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
				}),
			),
		).toThrow("ENV_UNSAFE_TEST_KEY");
	});

	it("env.tsのテスト公開鍵定数はfixtureの公開鍵と一致する", () => {
		expect(TEST_VAPID_PUBLIC_KEY).toBe(JSON.parse(testVapidText).publicKey);
	});

	it.each([
		"mailto:dev@latch.invalid",
		"mailto:dev@example.com",
		"mailto:x@EXAMPLE.ORG",
		"mailto:y@example.net",
		"mailto:dev@example.com.",
		"mailto:dev@example.com?x=1",
		"  mailto:dev@example.com  ",
		"mailto:dev@latch.invalid.",
	])("prodで仮の送信者%sは例外(ENV_PLACEHOLDER_VAPID_SUBJECT)", (subject) => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					...PUSH_OK,
					VAPID_SUBJECT: subject,
				}),
			),
		).toThrow("ENV_PLACEHOLDER_VAPID_SUBJECT");
	});

	it("prodで実在しうる送信者mailto:ops@latch.appは通る", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({ LATCH_ENV: "production", JWT_SECRET: SECRET_32, ...PUSH_OK }),
			),
		).not.toThrow();
	});

	it.each(["local", "staging"])(
		"%sではmailto:dev@example.comでも例外にならない",
		(e) => {
			expect(() =>
				assertEnvSafety(
					makeEnv({
						LATCH_ENV: e as Env["LATCH_ENV"],
						JWT_SECRET: SECRET_32,
						VAPID_SUBJECT: "mailto:dev@example.com",
						ACCESS_AUD: "fake-aud",
						ACCESS_TEAM_DOMAIN: "https://fake.cloudflareaccess.com",
					}),
				),
			).not.toThrow();
		},
	);

	it("vapidKeysOfは環境変数からVapidKeysを作る(未設定は例外)", () => {
		const keys = vapidKeysOf(
			makeEnv({
				VAPID_PUBLIC_KEY: "pub",
				VAPID_PRIVATE_KEY: '{"kty":"EC"}',
				VAPID_SUBJECT: "mailto:a@b.c",
			}),
		);
		expect(keys).toEqual({
			publicKey: "pub",
			privateJwk: { kty: "EC" },
			subject: "mailto:a@b.c",
		});
		expect(() => vapidKeysOf(makeEnv({}))).toThrow("ENV_MISSING_VAPID");
	});

	it("prodでテスト鍵(LATCH_TEST_IDP_JWKS)が残存すると例外", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					LATCH_TEST_IDP_JWKS: "{}",
				}),
			),
		).toThrow("ENV_UNSAFE_TEST_KEY");
	});

	it("prodでdevサインイン用秘密鍵(LATCH_TEST_IDP_PRIVATE_JWKS)が残存すると例外(F2' Task 2の二重防御)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					LATCH_TEST_IDP_PRIVATE_JWKS: "{}",
				}),
			),
		).toThrow("ENV_UNSAFE_TEST_KEY");
	});

	it("prodでキュー消費停止印(TEST_QUEUES_DISABLED)が設定されると例外", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					TEST_QUEUES_DISABLED: "1",
				}),
			),
		).toThrow("ENV_UNSAFE_TEST_QUEUE_GUARD");
	});

	it("prodでレート制限の緩和(LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX)が設定されていたら例外(docs/10 §5)", () => {
		for (const prefix of ["load-", "e2e-", ""]) {
			expect(() =>
				assertEnvSafety(
					makeEnv({
						LATCH_ENV: "production",
						JWT_SECRET: SECRET_32,
						...PUSH_OK,
						LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: prefix,
					}),
				),
			).toThrow("ENV_UNSAFE_RATE_LIMIT_RELAX");
		}
	});

	it("stagingとlocalではレート制限の緩和の設定で起動を拒否しない", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "staging",
					ACCESS_AUD: "aud",
					ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com",
					LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-",
				}),
			),
		).not.toThrow();
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "local",
					LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "e2e-",
				}),
			),
		).not.toThrow();
	});

	it("prodでAPI_RATE_LIMITERバインディングが無ければ例外(docs/04 §5)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "production",
					JWT_SECRET: SECRET_32,
					...PUSH_OK,
					API_RATE_LIMITER: undefined,
				}),
			),
		).toThrow("ENV_MISSING_RATE_LIMITER");
	});

	it("prodでJWT_SECRET未設定は例外", () => {
		expect(() => assertEnvSafety(makeEnv({ LATCH_ENV: "production" }))).toThrow(
			"ENV_UNSAFE_JWT_SECRET",
		);
	});

	it("prodでJWT_SECRETが31字(32字未満)は例外", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({ LATCH_ENV: "production", JWT_SECRET: "a".repeat(31) }),
			),
		).toThrow("ENV_UNSAFE_JWT_SECRET");
	});

	it("localはJWT_SECRET未設定でも通る(ガードはprodのみ)", () => {
		expect(() =>
			assertEnvSafety(makeEnv({ LATCH_ENV: "local" })),
		).not.toThrow();
	});

	it("stagingも通る(Accessの設定があればprodの検査はしない)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({
					LATCH_ENV: "staging",
					JWT_SECRET: "a".repeat(31),
					ACCESS_AUD: "fake-aud",
					ACCESS_TEAM_DOMAIN: "https://fake.cloudflareaccess.com",
				}),
			),
		).not.toThrow();
	});
});

describe("jwtSecret(docs/04 §4: JWT署名鍵の解決)", () => {
	it("local+未設定はDEV_FALLBACK_JWT_SECRET(開発/テスト専用鍵)", () => {
		expect(jwtSecret(makeEnv({ LATCH_ENV: "local" }))).toBe(
			DEV_FALLBACK_JWT_SECRET,
		);
	});

	it("local+設定済みは設定値を優先する", () => {
		expect(
			jwtSecret(makeEnv({ LATCH_ENV: "local", JWT_SECRET: SECRET_32 })),
		).toBe(SECRET_32);
	});

	it("production+設定済みはその値", () => {
		expect(
			jwtSecret(makeEnv({ LATCH_ENV: "production", JWT_SECRET: SECRET_32 })),
		).toBe(SECRET_32);
	});

	it("production+未設定は例外", () => {
		expect(() => jwtSecret(makeEnv({ LATCH_ENV: "production" }))).toThrow(
			"JWT_SECRET_MISSING",
		);
	});

	it("DEV_FALLBACK_JWT_SECRETは32字以上(prodガードと同じ下限)", () => {
		expect(DEV_FALLBACK_JWT_SECRET.length).toBeGreaterThanOrEqual(32);
	});
});
