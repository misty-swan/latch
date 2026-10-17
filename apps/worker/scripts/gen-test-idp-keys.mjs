/**
 * テスト専用IdP鍵ペアの生成(docs/04 §4: テスト鍵モード用の公開JWKS)。
 * 実行: apps/worker配下で `node scripts/gen-test-idp-keys.mjs`
 * jose(jose@6)でRSA 2048のRS256鍵ペアを1組生成し、公開JWKSと秘密鍵JWKを
 * tests/fixturesへ書き出す(どちらもコミットする生成物)。
 * 鍵はテスト専用であり、prodではassertEnvSafetyがLATCH_TEST_IDP_JWKSの設定自体を
 * 拒否する(docs/10 §2)ため、コミット済み鍵が本番で使われることはない。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";

/** kidは固定(フィクスチャ参照の安定性のため)。鍵そのものは実行のたびに新規生成される */
const KID = "test-idp-key-1";

const fixturesDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"tests",
	"fixtures",
);

// 秘密鍵JWKを書き出すためextractableを有効化(既定は非extractable)
const { privateKey } = await generateKeyPair("RS256", {
	extractable: true,
	modulusLength: 2048,
});
const exported = await exportJWK(privateKey);

/** 秘密鍵JWKの必須要素(RSAの公開要素+CRT要素)を取り出す */
const { kty, n, e, d, p, q, dp, dq, qi } = exported;
for (const [name, value] of Object.entries({
	kty,
	n,
	e,
	d,
	p,
	q,
	dp,
	dq,
	qi,
})) {
	if (typeof value !== "string") {
		throw new Error(`秘密鍵JWKの要素が欠落しています: ${name}`);
	}
}

/** 公開JWK(JWKS用・秘密要素d/p/q等を含まない) */
const publicJwk = { kty, n, e, kid: KID, alg: "RS256", use: "sig" };

/** 秘密鍵JWK(統合試験・E2Eがテスト用IDトークンを署名するために使う) */
const privateJwk = {
	kty,
	n,
	e,
	d,
	p,
	q,
	dp,
	dq,
	qi,
	kid: KID,
	alg: "RS256",
	use: "sig",
};

const jwks = { keys: [publicJwk] };

await mkdir(fixturesDir, { recursive: true });
await writeFile(
	path.join(fixturesDir, "test-idp-jwks.json"),
	`${JSON.stringify(jwks, null, "\t")}\n`,
);
await writeFile(
	path.join(fixturesDir, "test-idp-private.jwk"),
	`${JSON.stringify(privateJwk, null, "\t")}\n`,
);
console.log(
	`生成完了: kid=${KID} → tests/fixtures/test-idp-jwks.json・tests/fixtures/test-idp-private.jwk`,
);
