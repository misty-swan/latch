import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import raw from "../../wrangler.jsonc?raw";
import { assertEnvSafety, type Env } from "../env";
import {
	ALERT_MAIL_SECRETS,
	checkProdConfig,
	FORBIDDEN_PROD_NAMES,
	REQUIRED_PROD_SECRETS,
	secretNamesOf,
} from "./prod-checks";

const prodVars = (
	parse(raw) as { env: { production: { vars: Record<string, string> } } }
).env.production.vars;

const RATE_LIMITER = {
	limit: async () => ({ success: true }),
} as unknown as RateLimit;

/** prodの必須シークレットに、テスト鍵ではない仮の値を入れたもの */
const PROD_SECRETS = {
	JWT_SECRET: "a".repeat(32),
	VAPID_PUBLIC_KEY: "B".repeat(87),
	VAPID_PRIVATE_KEY: "{}",
	VAPID_SUBJECT: "mailto:ops@latch.app",
} satisfies Record<(typeof REQUIRED_PROD_SECRETS)[number], string>;

/** prodのvarsはLLMとEmbeddingがreal(LAT-91)なので、LLMのAPIキー2件も加えたもの */
const PROD_SECRETS_WITH_LLM = {
	...PROD_SECRETS,
	ANTHROPIC_API_KEY: "x",
	TYPESAFE_API_KEY: "x",
};

describe("checkProdConfig(docs/11 §1・LAT-122)", () => {
	it("wrangler.jsoncのenv.productionのvarsと必須のシークレットだけなら問題なし", () => {
		const result = checkProdConfig(
			prodVars,
			Object.keys(PROD_SECRETS_WITH_LLM),
		);
		expect(result.problems).toEqual([]);
	});

	it("同じ組み合わせは起動ガード(assertEnvSafety)も通る", () => {
		const env = {
			API_RATE_LIMITER: RATE_LIMITER,
			...prodVars,
			...PROD_SECRETS_WITH_LLM,
		} as unknown as Env;
		expect(() => assertEnvSafety(env)).not.toThrow();
	});

	it.each(FORBIDDEN_PROD_NAMES)(
		"%sがシークレットにあれば問題とし、起動ガードも拒む",
		(name) => {
			const result = checkProdConfig(prodVars, [
				...Object.keys(PROD_SECRETS_WITH_LLM),
				name,
			]);
			expect(result.problems).toEqual([
				`シークレットに${name}がある(起動ガードが拒む)`,
			]);
			const env = {
				API_RATE_LIMITER: RATE_LIMITER,
				...prodVars,
				...PROD_SECRETS_WITH_LLM,
				[name]: "x",
			} as unknown as Env;
			expect(() => assertEnvSafety(env)).toThrow();
		},
	);

	it("varsに禁止の名前があれば問題とする", () => {
		const result = checkProdConfig(
			{ ...prodVars, LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-" },
			Object.keys(PROD_SECRETS_WITH_LLM),
		);
		expect(result.problems).toEqual([
			"varsにLATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIXがある(起動ガードが拒む)",
		]);
	});

	it.each(REQUIRED_PROD_SECRETS)("%sが無ければ問題とする", (name) => {
		const names = Object.keys(PROD_SECRETS_WITH_LLM).filter((n) => n !== name);
		expect(checkProdConfig(prodVars, names).problems).toEqual([
			`シークレットに${name}が無い`,
		]);
	});

	it("LATCH_LLM_MODE=realならLLMのAPIキー2件を求める", () => {
		const vars = { ...prodVars, LATCH_LLM_MODE: "real" };
		// LLMのAPIキーを除いた必須のシークレットだけを渡す
		expect(checkProdConfig(vars, Object.keys(PROD_SECRETS)).problems).toEqual([
			"LATCH_LLM_MODE=realなのにシークレットにANTHROPIC_API_KEYが無い(ENV_MISSING_LLM_KEY)",
			"LATCH_LLM_MODE=realなのにシークレットにTYPESAFE_API_KEYが無い(ENV_MISSING_LLM_KEY)",
		]);
		expect(
			checkProdConfig(vars, [
				...Object.keys(PROD_SECRETS),
				"ANTHROPIC_API_KEY",
				"TYPESAFE_API_KEY",
			]).problems,
		).toEqual([]);
	});

	it("LATCH_ENVとLATCH_PUSH_MODEの取り違えを問題とする", () => {
		const result = checkProdConfig(
			{ ...prodVars, LATCH_ENV: "staging", LATCH_PUSH_MODE: "stub" },
			Object.keys(PROD_SECRETS_WITH_LLM),
		);
		expect(result.problems).toEqual([
			"varsのLATCH_ENVがproductionではない(staging)。起動ガードが働かない",
			"varsのLATCH_PUSH_MODEがrealではない(ENV_UNSAFE_PUSH)",
		]);
	});

	it("realでないモードと本番IdPの値の欠落は注意として返す", () => {
		const result = checkProdConfig(
			{ ...prodVars, LATCH_LLM_MODE: "stub" },
			Object.keys(PROD_SECRETS_WITH_LLM),
		);
		expect(result.notes).toEqual([
			"Parser/JevかEmbeddingがrealではない(公開の前提はreal固定・docs/11 §1・LAT-91)",
			"シークレットにALERT_MAIL_TOが無い(コストアラートと日次サマリが届かない・docs/runbooks/prod.md・LAT-86)",
			"シークレットにALERT_MAIL_FROMが無い(コストアラートと日次サマリが届かない・docs/runbooks/prod.md・LAT-86)",
			"GOOGLE_CLIENT_IDが無い(本番IdPの接続・LAT-90)",
			"APPLE_CLIENT_IDが無い(本番IdPの接続・LAT-90)",
		]);
	});

	it("オーナーへのメールの宛先と送り元が揃い、LATCH_MAIL_MODE=realなら注意を出さない", () => {
		const names = [
			...Object.keys(PROD_SECRETS_WITH_LLM),
			...ALERT_MAIL_SECRETS,
			"GOOGLE_CLIENT_ID",
			"APPLE_CLIENT_ID",
		];
		expect(checkProdConfig(prodVars, names)).toEqual({
			problems: [],
			notes: [],
		});
		expect(
			checkProdConfig({ ...prodVars, LATCH_MAIL_MODE: "stub" }, names).notes,
		).toEqual([
			"varsのLATCH_MAIL_MODEがrealではない(コストアラートと日次サマリが届かない・docs/11 §1)",
		]);
	});
});

describe("secretNamesOf", () => {
	it("wrangler secret listの配列から名前を取り出す", () => {
		expect(
			secretNamesOf([
				{ name: "JWT_SECRET", type: "secret_text" },
				{ name: "VAPID_SUBJECT", type: "secret_text" },
			]),
		).toEqual(["JWT_SECRET", "VAPID_SUBJECT"]);
	});

	it("配列でない・名前の無い行は例外", () => {
		expect(() => secretNamesOf({})).toThrow();
		expect(() => secretNamesOf([{ type: "secret_text" }])).toThrow();
	});
});
