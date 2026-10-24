/**
 * CIの照合(設計書 §3.4)。wrangler.jsonc のどれかの環境でLATCH_LLM_MODEがrealなら、
 * 合格した採点の記録(eval/records/gate.json)が今のファイルと一致することを求める。
 * 本物のAIは呼ばない(記録とファイルを読むだけ)。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_FILES, fingerprint } from "./lib/fingerprint";
import { checkGate } from "./lib/gate-check";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const wrangler = (top: string, staging: string) => `{
	// コメントと末尾のカンマを含むJSONC
	"name": "latch-worker",
	"vars": {
		"LATCH_LLM_MODE": "${top}", /* 既定 */
		"NOTE": "// これは文字列でコメントではない",
	},
	"env": {
		"staging": {
			"vars": { "LATCH_LLM_MODE": "${staging}" },
		},
		"other": { "name": "x" },
	},
}
`;

type Record = {
	passed: boolean;
	goldset: { approvedByOwner: string | null };
	models: { typesafe_requested: string };
	fingerprint: { [k: string]: string };
};

const makeRepo = (opts: {
	top?: string;
	staging?: string;
	record?: (r: Record) => void;
	noRecord?: boolean;
}): string => {
	const root = mkdtempSync(join(tmpdir(), "gate-check-"));
	for (const f of FINGERPRINT_FILES) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), `内容 ${f}\n`);
	}
	mkdirSync(join(root, "apps/worker"), { recursive: true });
	writeFileSync(
		join(root, "apps/worker/wrangler.jsonc"),
		wrangler(opts.top ?? "stub", opts.staging ?? "stub"),
	);
	if (!opts.noRecord) {
		const record: Record = {
			passed: true,
			goldset: { approvedByOwner: "2026-10-24" },
			models: { typesafe_requested: "jev-1.13.0" },
			fingerprint: fingerprint(root),
		};
		opts.record?.(record);
		mkdirSync(join(root, "eval/records"), { recursive: true });
		writeFileSync(
			join(root, "eval/records/gate.json"),
			JSON.stringify(record, null, 2),
		);
	}
	return root;
};

describe("checkGate", () => {
	it("今のリポジトリで通る", () => {
		expect(checkGate(repoRoot)).toEqual([]);
	});

	it("どの環境もrealでなければ、記録が無くても通る", () => {
		expect(checkGate(makeRepo({ noRecord: true }))).toEqual([]);
	});

	it("env.*のどれかがrealで記録が無ければ落ちる", () => {
		const errs = checkGate(makeRepo({ staging: "real", noRecord: true }));
		expect(errs).toHaveLength(1);
		expect(errs[0]).toMatch(/gate\.json/);
		expect(errs[0]).toMatch(/env\.staging/);
	});

	it("realで、合格・承認済み・指紋一致・固定したモデル名の記録なら通る", () => {
		expect(checkGate(makeRepo({ top: "real", staging: "real" }))).toEqual([]);
	});

	it("不合格の記録は落ちる", () => {
		const errs = checkGate(
			makeRepo({
				top: "real",
				record: (r) => {
					r.passed = false;
				},
			}),
		);
		expect(errs.join("\n")).toMatch(/passed/);
	});

	it("未承認のゴールドセットでの記録は落ちる", () => {
		const errs = checkGate(
			makeRepo({
				top: "real",
				record: (r) => {
					r.goldset.approvedByOwner = null;
				},
			}),
		);
		expect(errs.join("\n")).toMatch(/承認/);
	});

	it("jev-latestで採点した記録は落ちる", () => {
		const errs = checkGate(
			makeRepo({
				top: "real",
				record: (r) => {
					r.models.typesafe_requested = "jev-latest";
				},
			}),
		);
		expect(errs.join("\n")).toMatch(/jev-latest/);
	});

	it("指紋が今のファイルと違えば、違うファイルを挙げて落ちる", () => {
		const root = makeRepo({ top: "real" });
		writeFileSync(join(root, "eval/goldset/parser.yaml"), "内容 変更\n");
		const errs = checkGate(root);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toMatch(/eval\/goldset\/parser\.yaml/);
	});

	it("記録がJSONとして読めなければ落ちる", () => {
		const root = makeRepo({ top: "real" });
		writeFileSync(join(root, "eval/records/gate.json"), "{壊れた");
		expect(checkGate(root)).toHaveLength(1);
	});
});
