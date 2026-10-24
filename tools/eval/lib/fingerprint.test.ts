import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CATEGORIES } from "@latch/shared";
import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_MODEL,
	JEV_ANTHROPIC_SYSTEM_PROMPT,
	JEV_OUTPUT_SCHEMA,
	JEV_QUESTIONS,
	PARSER_OUTPUT_SCHEMA,
	PARSER_SYSTEM_PROMPT,
	TYPESAFE_MODEL,
} from "../../../apps/worker/src/llm/real/prompts";
import { PARTICIPANTS_WARNING } from "../../../apps/worker/src/llm/stub/parser";
import {
	ARTIFACTS_RENDER_AT,
	artifactsFingerprint,
	canonicalJson,
	FINGERPRINT_FILES,
	fingerprint,
	renderArtifacts,
} from "./fingerprint";

const makeRepo = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fingerprint-"));
	for (const f of FINGERPRINT_FILES) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), `内容 ${f}\n`);
	}
	return root;
};

describe("fingerprint", () => {
	it("対象のファイルそれぞれのSHA-256を返す", () => {
		expect(FINGERPRINT_FILES).toEqual([
			"apps/worker/src/llm/real/prompts.ts",
			"apps/worker/src/llm/real/anthropic.ts",
			"apps/worker/src/llm/real/parser.ts",
			"apps/worker/src/llm/real/jev-typesafe.ts",
			"apps/worker/src/llm/real/jev-anthropic.ts",
			"apps/worker/src/llm/expiry.ts",
			"apps/worker/src/intents/expiry.ts",
			"apps/worker/src/llm/mode.ts",
			"apps/worker/src/pipeline/normalize.ts",
			"eval/goldset/parser.yaml",
			"eval/goldset/jev-pairs.yaml",
		]);
		const fp = fingerprint(makeRepo());
		expect(Object.keys(fp)).toEqual([...FINGERPRINT_FILES]);
		for (const v of Object.values(fp)) expect(v).toMatch(/^[0-9a-f]{64}$/);
	});

	it("1文字の変更で、そのファイルの指紋だけが変わる", () => {
		const root = makeRepo();
		const before = fingerprint(root);
		const target = "apps/worker/src/llm/real/prompts.ts";
		writeFileSync(join(root, target), `内容 ${target}!\n`);
		const after = fingerprint(root);
		expect(after[target]).not.toBe(before[target]);
		for (const f of FINGERPRINT_FILES.filter((f) => f !== target)) {
			expect(after[f]).toBe(before[f]);
		}
	});

	it("対象のファイルが無ければ例外", () => {
		expect(() => fingerprint(mkdtempSync(join(tmpdir(), "fp-")))).toThrow();
	});
});

describe("canonicalJson", () => {
	it("キーを辞書順に並べ、入れ子と配列も同じ規則で書く", () => {
		expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
			'{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}',
		);
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});
});

describe("renderArtifacts・artifactsFingerprint", () => {
	it("モデルとのやり取りを形づくる値を、固定した時刻で描いた形で持つ", () => {
		const a = renderArtifacts();
		expect(a.parser_system_prompt).toBe(
			PARSER_SYSTEM_PROMPT(ARTIFACTS_RENDER_AT),
		);
		expect(ARTIFACTS_RENDER_AT).toBe("2026-01-01T00:00:00+09:00");
		expect(a.parser_output_schema).toEqual(PARSER_OUTPUT_SCHEMA);
		expect(a.jev_questions).toEqual(JEV_QUESTIONS);
		expect(a.jev_anthropic_system_prompt).toBe(JEV_ANTHROPIC_SYSTEM_PROMPT);
		expect(a.jev_output_schema).toEqual(JEV_OUTPUT_SCHEMA);
		expect(a.anthropic_model).toBe(ANTHROPIC_MODEL);
		expect(a.typesafe_model).toBe(TYPESAFE_MODEL);
		expect(a.participants_warning).toEqual(PARTICIPANTS_WARNING);
		expect(a.categories).toEqual([...CATEGORIES]);
		// 期限の計算(occasionDefaultExpiry・EXPIRY_CHOICES_DAYS)も描いた値で持つ
		expect(a.expiry_options).toEqual({
			connection: [
				"2026-01-08T00:00:00+09:00",
				"2026-01-31T00:00:00+09:00",
				"2026-04-01T00:00:00+09:00",
			],
			occasion: ["2026-01-01T22:00:00+09:00"],
			occasion_without_time: [],
		});
	});

	it("描いた値の正規のJSONのSHA-256(16進)で、何度計算しても同じ", () => {
		const hash = artifactsFingerprint();
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(artifactsFingerprint()).toBe(hash);
		expect(
			artifactsFingerprint({ ...renderArtifacts(), categories: [] }),
		).not.toBe(hash);
	});
});
