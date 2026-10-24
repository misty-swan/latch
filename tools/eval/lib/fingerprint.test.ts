import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_FILES, fingerprint } from "./fingerprint";

const makeRepo = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fingerprint-"));
	for (const f of FINGERPRINT_FILES) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), `内容 ${f}\n`);
	}
	return root;
};

describe("fingerprint", () => {
	it("対象の4ファイルそれぞれのSHA-256を返す", () => {
		expect(FINGERPRINT_FILES).toEqual([
			"apps/worker/src/llm/real/prompts.ts",
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
