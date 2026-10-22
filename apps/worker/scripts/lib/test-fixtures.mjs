/**
 * テスト用の鍵(tests/fixtures)を読む共有部(docs/04 §4・docs/10 §2)。
 * prepare-dev-vars.mjs(ローカルの.dev.vars)とput-staging-secrets.mjs(staging)が
 * 同じ元から値を作る(F8b設計 §1.4。手で写さない)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/worker(scripts/libの2つ上) */
export const workerDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** JSON文字列を1行へ整える(キー順は元ファイルのまま=決定的) */
const oneLineJson = (file) =>
	JSON.stringify(JSON.parse(readFileSync(file, "utf8")));

/** 公開JWKS(1行JSON) */
export const jwksOneLine = oneLineJson(
	path.join(workerDir, "tests/fixtures/test-idp-jwks.json"),
);

/** 秘密JWK(devサインインの署名鍵・1行JSON) */
export const privateJwkOneLine = oneLineJson(
	path.join(workerDir, "tests/fixtures/test-idp-private.jwk"),
);

/** テスト用VAPID鍵(公開鍵とJWK) */
export const testVapid = JSON.parse(
	readFileSync(path.join(workerDir, "tests/fixtures/test-vapid.json"), "utf8"),
);

/** VAPIDの連絡先(Appleは.invalid等の予約ドメインを403 BadJwtTokenで拒否するためexample.comを使う) */
export const vapidSubject = "mailto:dev@example.com";
