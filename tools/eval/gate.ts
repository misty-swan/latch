/**
 * 精度ゲートの採点のコマンド(設計書 §3・`pnpm eval:gate`)。
 * 本物のAnthropic・TypeSafeを呼ぶ(課金あり)ため、CIでは実行しない(CIは記録の照合だけ)。
 * APIキーは環境変数ANTHROPIC_API_KEY・TYPESAFE_API_KEY、無ければtools/eval/.env(git管理外)から読む。
 * 記録をeval/records/gate.jsonへ書き、要約を標準出力へ出す。キー・URLは出力しない。
 * 終了コード: 0=合格・1=不合格・2=実行できない(キーが無い等)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_RECORD_PATH } from "./lib/gate-check";
import { formatSummary, runGate } from "./lib/runner";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const envPath = join(here, ".env");

const main = async (): Promise<number> => {
	if (existsSync(envPath)) process.loadEnvFile(envPath);
	const anthropic = process.env.ANTHROPIC_API_KEY ?? "";
	const typesafe = process.env.TYPESAFE_API_KEY ?? "";
	const missing = [
		anthropic === "" ? "ANTHROPIC_API_KEY" : null,
		typesafe === "" ? "TYPESAFE_API_KEY" : null,
	].filter((v) => v !== null);
	if (missing.length > 0) {
		console.error(
			`採点を始められません: APIキー(${missing.join("・")})がありません。tools/eval/.env に書くか、環境変数で渡してください。`,
		);
		return 2;
	}

	console.log(
		"精度ゲートの採点を始めます(Parser・Jevの第一候補と予備を呼びます)…",
	);
	const record = await runGate({ repoRoot, keys: { anthropic, typesafe } });
	const out = join(repoRoot, GATE_RECORD_PATH);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
	process.stdout.write(formatSummary(record));
	console.log(`記録: ${GATE_RECORD_PATH}`);
	return record.passed ? 0 : 1;
};

main().then(
	(code) => {
		process.exitCode = code;
	},
	(e: unknown) => {
		// 例外の積み上げ(スタック)は出さず、理由の文だけを出す
		console.error(
			`採点を中断しました: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exitCode = 2;
	},
);
