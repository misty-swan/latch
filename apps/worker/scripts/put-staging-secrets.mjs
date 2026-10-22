/**
 * stagingのシークレット登録(F8b設計 §1.4)。値はprepare-dev-vars.mjsと同じfixtures
 * (tests/fixtures)から作り、`wrangler secret put <名前> --env staging`の標準入力へ渡す。
 * 値は標準出力にも引数にも出さない(JWT_SECRETは実行ごとに新しく生成する)。
 *   node scripts/put-staging-secrets.mjs            # 登録
 *   node scripts/put-staging-secrets.mjs --dry-run   # 名前だけ表示(何も登録しない)
 */

import { randomBytes } from "node:crypto";
import {
	jwksOneLine,
	privateJwkOneLine,
	testVapid,
	vapidSubject,
} from "./lib/test-fixtures.mjs";
import { wrangler } from "./lib/wrangler-cli.mjs";

const dryRun = process.argv.includes("--dry-run");

/** 登録するシークレット(docs/10 §2のstaging。テスト鍵はdevサインインを有効にするため) */
const secrets = {
	JWT_SECRET: randomBytes(32).toString("base64url"),
	LATCH_TEST_IDP_JWKS: jwksOneLine,
	LATCH_TEST_IDP_PRIVATE_JWKS: privateJwkOneLine,
	VAPID_PUBLIC_KEY: testVapid.publicKey,
	VAPID_PRIVATE_KEY: JSON.stringify(testVapid.privateJwk),
	VAPID_SUBJECT: vapidSubject,
};

let failed = 0;
for (const [name, value] of Object.entries(secrets)) {
	if (dryRun) {
		console.log(`[dry-run] 登録予定: ${name}`);
		continue;
	}
	// 失敗時もwranglerの出力にシークレットの値は含まれないが、名前と終了コードだけ表示する
	const r = wrangler(["secret", "put", name, "--env", "staging"], {
		input: value,
	});
	if (r.status === 0) console.log(`登録: ${name}`);
	else {
		failed++;
		console.error(`失敗: ${name}(終了コード${r.status})`);
	}
}
if (failed > 0) process.exit(1);
