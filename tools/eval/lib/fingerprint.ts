/**
 * 採点の記録の指紋(設計書 §3.2)。指示文・モデル名(prompts.ts)・正規化の関数・ゴールドセットの
 * SHA-256を記録に持ち、CIが今のファイルから計算し直して照合する。1文字でも変われば採り直しになる。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 指紋の対象(リポジトリのルートからの相対パス) */
export const FINGERPRINT_FILES = [
	"apps/worker/src/llm/real/prompts.ts",
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
