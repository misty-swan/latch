/**
 * CIの照合(設計書 §3.4)。apps/worker/wrangler.jsonc のトップレベルと全env.*の
 * vars.LATCH_LLM_MODEにrealがあれば、eval/records/gate.json が合格・承認済みの
 * ゴールドセット・固定したTypeSafeのモデル名・今のファイルと同じ指紋であることを求める。
 * 問題を日本語の文で返す(空配列=通る)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { fingerprint } from "./fingerprint";

export const GATE_RECORD_PATH = "eval/records/gate.json";
const WRANGLER_PATH = "apps/worker/wrangler.jsonc";

type Vars = { vars?: { LATCH_LLM_MODE?: unknown } };

/** LATCH_LLM_MODEがrealの環境名(トップレベルは"トップレベル"・他は"env.<名前>") */
const realEnvironments = (repoRoot: string): string[] => {
	const errors: ParseError[] = [];
	const config = parseJsonc(
		readFileSync(join(repoRoot, WRANGLER_PATH), "utf8"),
		errors,
		{ allowTrailingComma: true },
	) as (Vars & { env?: Record<string, Vars> }) | undefined;
	if (errors.length > 0 || config === undefined) {
		throw new Error(`${WRANGLER_PATH} を読めませんでした`);
	}
	const found: string[] = [];
	if (config.vars?.LATCH_LLM_MODE === "real") found.push("トップレベル");
	for (const [name, env] of Object.entries(config.env ?? {})) {
		if (env?.vars?.LATCH_LLM_MODE === "real") found.push(`env.${name}`);
	}
	return found;
};

export const checkGate = (repoRoot: string): string[] => {
	const envs = realEnvironments(repoRoot);
	if (envs.length === 0) return [];
	const where = `LATCH_LLM_MODE=realの環境(${envs.join("・")})`;

	const recordPath = join(repoRoot, GATE_RECORD_PATH);
	if (!existsSync(recordPath)) {
		return [`${where}があるのに ${GATE_RECORD_PATH} がありません`];
	}
	let record: {
		passed?: unknown;
		goldset?: { approvedByOwner?: unknown };
		models?: { typesafe_requested?: unknown };
		fingerprint?: Record<string, unknown>;
	};
	try {
		record = JSON.parse(readFileSync(recordPath, "utf8"));
	} catch {
		return [`${GATE_RECORD_PATH} をJSONとして読めません`];
	}

	const problems: string[] = [];
	if (record.passed !== true) {
		problems.push(`${GATE_RECORD_PATH} がpassed: trueではありません(${where})`);
	}
	if (
		typeof record.goldset?.approvedByOwner !== "string" ||
		record.goldset.approvedByOwner === ""
	) {
		problems.push(
			`${GATE_RECORD_PATH} はオーナーの承認が無いゴールドセットで採点されています`,
		);
	}
	const requested = record.models?.typesafe_requested;
	if (typeof requested !== "string" || requested === "jev-latest") {
		problems.push(
			`${GATE_RECORD_PATH} のTypeSafeのモデル名が固定されていません(jev-latestまたは不明)`,
		);
	}
	const now = fingerprint(repoRoot);
	for (const [file, hash] of Object.entries(now)) {
		if (record.fingerprint?.[file] !== hash) {
			problems.push(
				`${file} が採点の後に変わっています(指紋が ${GATE_RECORD_PATH} と一致しません)。採り直してください`,
			);
		}
	}
	return problems;
};
