/**
 * 照合のコマンド(check-gate.ts)の試験。デプロイの前に使うため、終了コードと日本語の文を確かめる。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const repoWith = (staging: string): string => {
	const root = mkdtempSync(join(tmpdir(), "check-gate-"));
	mkdirSync(join(root, "apps/worker"), { recursive: true });
	writeFileSync(
		join(root, "apps/worker/wrangler.jsonc"),
		`{ "env": { "staging": { "vars": { "LATCH_LLM_MODE": "${staging}" } } } }`,
	);
	return root;
};

const run = (root: string) =>
	spawnSync("pnpm", ["exec", "tsx", "check-gate.ts", root], {
		cwd: here,
		encoding: "utf8",
	});

describe("check-gate.ts", () => {
	it("どの環境もrealでなければ0で終わる", () => {
		const r = run(repoWith("stub"));
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/通りました/);
	});

	it("realで記録が無ければ1で終わり、理由を日本語で出す", () => {
		const r = run(repoWith("real"));
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/精度ゲートの照合が通りません/);
		expect(r.stderr).toMatch(/gate\.json/);
	});
}, 60_000);
