/**
 * CIの照合(設計書 §3.4)。apps/worker/wrangler.jsonc のトップレベルと全env.*の
 * vars.LATCH_LLM_MODEにrealがあれば、eval/records/gate.json が合格・JevのRecall@0.60が基準以上(第一候補と予備)・承認済みの
 * ゴールドセット・固定したTypeSafeのモデル名(応答した版も固定した版だけ)・今のprompts.tsと同じモデル名・
 * 今のファイルと同じ指紋・今の値から描いた値と同じ指紋であることを求める。
 * 問題を日本語の文で返す(空配列=通る)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { artifactsFingerprint, fingerprint } from "./fingerprint";
import { CRITERIA } from "./score";

export const GATE_RECORD_PATH = "eval/records/gate.json";
const WRANGLER_PATH = "apps/worker/wrangler.jsonc";
const PROMPTS_PATH = "apps/worker/src/llm/real/prompts.ts";

/** prompts.ts の `export const 名前 = "値";` を読む(一時ディレクトリの検査でも同じ経路で読むため) */
export const readModelConstant = (
	repoRoot: string,
	name: string,
): string | null => {
	const src = readFileSync(join(repoRoot, PROMPTS_PATH), "utf8");
	const m = new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`).exec(src);
	return m ? (m[1] as string) : null;
};

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
		scores?: {
			jevAt060?: Record<
				string,
				{ truePositive?: unknown; actualPositive?: unknown } | undefined
			>;
		};
		goldset?: { approvedByOwner?: unknown };
		models?: {
			anthropic?: unknown;
			typesafe_requested?: unknown;
			typesafe_answered?: unknown;
		};
		fingerprint?: Record<string, unknown>;
		fingerprintArtifacts?: unknown;
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
	// Recall@0.60を合否に加える前の記録(値が無い)や、基準を下回る記録を通さない(LAT-114)
	for (const [key, name] of [
		["primary", "第一候補TypeSafe"],
		["fallback", "予備Anthropic"],
	] as const) {
		const at = record.scores?.jevAt060?.[key];
		const tp = at?.truePositive;
		const pos = at?.actualPositive;
		if (
			typeof tp !== "number" ||
			typeof pos !== "number" ||
			pos === 0 ||
			tp * 100 < CRITERIA.jevRecallAt060 * pos
		) {
			problems.push(
				`${GATE_RECORD_PATH} のJevのRecall@0.60(${name})が無いか、基準${CRITERIA.jevRecallAt060}%以上を満たしません。採り直してください`,
			);
		}
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
	} else if (requested !== readModelConstant(repoRoot, "TYPESAFE_MODEL")) {
		problems.push(
			`${GATE_RECORD_PATH} のTypeSafeのモデル名(${requested})が今のTYPESAFE_MODELと違います。採り直してください`,
		);
	}
	// 応答した版が固定した版だけであること(別の版で採点した結果を混ぜない)
	const pinned = readModelConstant(repoRoot, "TYPESAFE_MODEL");
	const answered = record.models?.typesafe_answered;
	if (
		!Array.isArray(answered) ||
		answered.length !== 1 ||
		answered[0] !== pinned
	) {
		problems.push(
			`${GATE_RECORD_PATH} のTypeSafeが応答した版(${Array.isArray(answered) ? answered.join(", ") || "なし" : "不明"})が、固定したTYPESAFE_MODEL(${pinned})だけではありません。採り直してください`,
		);
	}
	if (
		record.models?.anthropic !== readModelConstant(repoRoot, "ANTHROPIC_MODEL")
	) {
		problems.push(
			`${GATE_RECORD_PATH} のAnthropicのモデル名が今のANTHROPIC_MODELと違います。採り直してください`,
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
	if (record.fingerprintArtifacts !== artifactsFingerprint()) {
		problems.push(
			`モデルとのやり取りを形づくる値(指示文・出力スキーマ・共有の定数など)が採点の後に変わっています(描いた値の指紋が ${GATE_RECORD_PATH} と一致しません)。採り直してください`,
		);
	}
	return problems;
};
