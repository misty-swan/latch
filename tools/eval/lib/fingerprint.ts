/**
 * 採点の記録の指紋(設計書 §3.2)。指示文・モデル名(prompts.ts)・realの呼び出し部品・正規化の関数・ゴールドセットの
 * SHA-256を記録に持ち、CIが今のファイルから計算し直して照合する。1文字でも変われば採り直しになる。
 * ファイルの指紋に加え、モデルとのやり取りを形づくる値を実際に描いた形(描いた値の指紋)も持つ。
 * 指示文やスキーマは@latch/sharedの定数(カテゴリの一覧・字数の上限・人数の範囲・期限の日数)を埋め込むため、
 * 対象のファイルを変えずに共有の定数だけを変えても採り直しになるようにする。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES } from "@latch/shared";
import { fixedClock } from "../../../apps/worker/src/clock/clock";
import { expiryOptions } from "../../../apps/worker/src/llm/expiry";
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

/**
 * 指紋の対象(リポジトリのルートからの相対パス)。指示文・モデル名に加え、
 * 応答の検証と後処理を持つrealの呼び出し部品と期限の計算も含める(変えれば採り直し)
 */
export const FINGERPRINT_FILES = [
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
] as const;

/** 対象ファイルごとのSHA-256(16進)。ファイルが無ければ例外 */
export const fingerprint = (repoRoot: string): Record<string, string> =>
	Object.fromEntries(
		FINGERPRINT_FILES.map((f) => [
			f,
			createHash("sha256")
				.update(readFileSync(join(repoRoot, f)))
				.digest("hex"),
		]),
	);

/** 描いた値の指紋で指示文を描く時刻(固定・JST) */
export const ARTIFACTS_RENDER_AT = "2026-01-01T00:00:00+09:00";

/** キーを辞書順に並べたJSON(入れ子・配列の中も同じ規則)。同じ値なら必ず同じ文字列になる */
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
};

/**
 * モデルとのやり取りを形づくる値を描く(設計書 §3.2)。指示文は固定の時刻で描き、
 * 期限の選択肢も同じ時刻で計算した値を持つ(期限の日数・機会の既定の期限の変更を拾うため)
 */
export const renderArtifacts = () => {
	const clock = fixedClock(new Date(ARTIFACTS_RENDER_AT));
	return {
		parser_system_prompt: PARSER_SYSTEM_PROMPT(ARTIFACTS_RENDER_AT),
		parser_output_schema: PARSER_OUTPUT_SCHEMA,
		jev_questions: JEV_QUESTIONS,
		jev_anthropic_system_prompt: JEV_ANTHROPIC_SYSTEM_PROMPT,
		jev_output_schema: JEV_OUTPUT_SCHEMA,
		anthropic_model: ANTHROPIC_MODEL,
		typesafe_model: TYPESAFE_MODEL,
		participants_warning: PARTICIPANTS_WARNING,
		categories: [...CATEGORIES],
		expiry_options: {
			connection: expiryOptions(clock, "connection", null),
			occasion: expiryOptions(clock, "occasion", {
				start: "2026-01-01T19:00:00+09:00",
			}),
			occasion_without_time: expiryOptions(clock, "occasion", null),
		},
	};
};

/** 描いた値の正規のJSONのSHA-256(16進) */
export const artifactsFingerprint = (
	artifacts: unknown = renderArtifacts(),
): string =>
	createHash("sha256").update(canonicalJson(artifacts)).digest("hex");
