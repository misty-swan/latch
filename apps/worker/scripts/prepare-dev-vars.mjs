/**
 * E2E用の.dev.vars生成(docs/04 §4のテスト鍵モード・docs/10 §1)。
 * PlaywrightのwebServerがwrangler devの前に実行する。値はすべてテスト専用の固定値:
 * - JWT_SECRET: 開発専用の固定文字列(32字以上・prodではassertEnvSafetyが設定必須と
 *   しつつテスト鍵と同様にprodへは出ない。docs/10 §2)
 * - LATCH_TEST_IDP_JWKS: コミット済みテスト鍵の公開JWKS(tests/fixtures)を1行JSON化。
 *   prodではassertEnvSafetyが同じ変数の設定自体を拒否するため、コミット済み鍵が
 *   本番で使われることはない(docs/10 §2)
 * 生成は決定的(同じ入力から常に同じ内容)で、実行のたびに上書きする。
 * .dev.varsはgitignore済みの生成物として扱う
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/worker(このスクリプトの1つ上) */
const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 公開JWKSを1行JSONへ整えて読む(キー順は元ファイルのまま=決定的) */
const jwksOneLine = JSON.stringify(
	JSON.parse(
		readFileSync(
			path.join(workerDir, "tests/fixtures/test-idp-jwks.json"),
			"utf8",
		),
	),
);

/** E2E専用の固定JWT署名鍵(32字以上・docs/10 §1の開発/テスト専用値) */
const devJwtSecret = "latch-e2e-dev-jwt-secret-0123456789abcdef0123456789";

if (devJwtSecret.length < 32) {
	throw new Error("E2E用JWT_SECRETが32字未満です(docs/10 §2)");
}

// dotenv形式。JSONに単一引用符は含まれないためリテラル引用で安全
const content = [
	`JWT_SECRET=${devJwtSecret}`,
	`LATCH_TEST_IDP_JWKS='${jwksOneLine}'`,
	"",
].join("\n");

writeFileSync(path.join(workerDir, ".dev.vars"), content);
console.log("生成完了: .dev.vars(E2E用のテスト専用値)");
