import { describe, expect, it } from "vitest";
import {
	assertEnvSafety,
	DEV_FALLBACK_JWT_SECRET,
	type Env,
	jwtSecret,
} from "./env";

// assertEnvSafety/jwtSecretはバインディング(DB等)を参照しないため、変数のみ与えるヘルパー
const makeEnv = (overrides: Partial<Env> = {}): Env =>
	({ ...overrides }) as unknown as Env;

const SECRET_32 = "a".repeat(32);

describe("assertEnvSafety(docs/04 §4・docs/10 §2: prodテスト鍵起動ガード)", () => {
	it("prod+32字のJWT_SECRETは通る", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({ LATCH_ENV: "production", JWT_SECRET: SECRET_32 }),
			),
		).not.toThrow();
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

	it("stagingも通る(prod以外は何もしない)", () => {
		expect(() =>
			assertEnvSafety(
				makeEnv({ LATCH_ENV: "staging", JWT_SECRET: "a".repeat(31) }),
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
