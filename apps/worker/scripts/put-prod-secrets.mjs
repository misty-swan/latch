/**
 * prodのシークレット登録(F10・docs/runbooks/prod.md 3章)。stagingと違い、テスト用の鍵
 * (tests/fixtures)は読まない。登録済みの名前は`wrangler secret list --env production`で調べ、
 * 未登録のものだけを新しく作って`wrangler secret put <名前> --env production`の標準入力へ渡す
 * (登録済みは上書きしない。JWT_SECRETを変えると全員のログインが切れ、VAPID鍵を変えると
 * 全員の通知の購読が無効になるため)。値は標準出力にも引数にも出さない。
 *   LATCH_VAPID_SUBJECT=mailto:<連絡先> node scripts/put-prod-secrets.mjs
 *   node scripts/put-prod-secrets.mjs --dry-run   # 登録予定の名前だけ表示(読み取りのみ)
 * 作るもの: JWT_SECRET(32バイトの乱数)・VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY(P-256の鍵の組を
 * その場で作る)・VAPID_SUBJECT(LATCH_VAPID_SUBJECTの値。仮の送信者は拒む)。
 * LLMのAPIキーと本番IdPの値は手順書のとおりオーナーが1件ずつ登録する。
 */

import { randomBytes, webcrypto } from "node:crypto";
import { isPlaceholderVapidSubject } from "../src/env.ts";
import { secretNamesOf } from "../src/ops/prod-checks.ts";
import { parseJsonOutput, wrangler, wranglerOk } from "./lib/wrangler-cli.mjs";

const dryRun = process.argv.includes("--dry-run");
const ENV = ["--env", "production"];

/** 登録済みの名前。Workerがまだ無い(初回)ときは一覧が取れないため、登録済みなしとして扱う */
function listRegistered() {
	const r = wrangler(["secret", "list", ...ENV, "--format", "json"]);
	if (r.status === 0) return secretNamesOf(parseJsonOutput(r.stdout));
	if (/not found|10007/i.test(`${r.stdout}\n${r.stderr}`)) {
		console.log("prodのWorkerはまだありません(登録時にwranglerが作ります)");
		return [];
	}
	// それ以外の失敗(ログイン切れ等)は出力を添えて止める
	wranglerOk(["secret", "list", ...ENV, "--format", "json"]);
	return [];
}
const registered = new Set(listRegistered());

/** VAPID鍵の組(公開鍵=base64urlの非圧縮点65バイト・秘密鍵=JWKのJSON。F7b設計 §5.3) */
async function newVapidKeys() {
	const pair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const raw = await webcrypto.subtle.exportKey("raw", pair.publicKey);
	const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
	return {
		publicKey: Buffer.from(raw).toString("base64url"),
		privateJwk: JSON.stringify(jwk),
	};
}

/** 登録する名前と、値を作る関数(未登録のときだけ呼ぶ) */
const planned = [];
if (!registered.has("JWT_SECRET")) {
	planned.push(["JWT_SECRET", () => randomBytes(32).toString("base64url")]);
}
const vapidNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];
const vapidMissing = vapidNames.filter((n) => !registered.has(n));
if (vapidMissing.length === 1) {
	// 片方だけ登録済みだと組が合わなくなる。片方だけ作り直すことはしない
	console.error(
		`止めました: ${vapidMissing[0]}だけが未登録です。VAPID鍵は2件を組で登録します(手順書 3章)`,
	);
	process.exit(1);
}
if (vapidMissing.length === 2) {
	let keys;
	planned.push(
		[
			"VAPID_PUBLIC_KEY",
			async () => {
				keys = await newVapidKeys();
				return keys.publicKey;
			},
		],
		["VAPID_PRIVATE_KEY", () => keys.privateJwk],
	);
}
if (!registered.has("VAPID_SUBJECT")) {
	const subject = (process.env.LATCH_VAPID_SUBJECT ?? "").trim();
	if (!dryRun) {
		if (!subject.toLowerCase().startsWith("mailto:")) {
			console.error(
				"止めました: LATCH_VAPID_SUBJECTに通知の送り手の連絡先(mailto:で始まる)を入れてください",
			);
			process.exit(1);
		}
		if (isPlaceholderVapidSubject(subject)) {
			console.error(
				"止めました: LATCH_VAPID_SUBJECTが仮の送信者(example.com等)です。prodの起動ガードが拒みます",
			);
			process.exit(1);
		}
	}
	planned.push(["VAPID_SUBJECT", () => subject]);
}

for (const name of registered) {
	if (["JWT_SECRET", ...vapidNames, "VAPID_SUBJECT"].includes(name)) {
		console.log(`登録済み(変えない): ${name}`);
	}
}
if (planned.length === 0) {
	console.log("新しく登録するものはありません");
	process.exit(0);
}

let failed = 0;
for (const [name, makeValue] of planned) {
	if (dryRun) {
		console.log(`[dry-run] 登録予定: ${name}`);
		continue;
	}
	// 失敗時もwranglerの出力にシークレットの値は含まれないが、名前と終了コードだけ表示する
	const r = wrangler(["secret", "put", name, ...ENV], {
		input: await makeValue(),
	});
	if (r.status === 0) console.log(`登録: ${name}`);
	else {
		failed++;
		console.error(`失敗: ${name}(終了コード${r.status})`);
		// VAPID鍵は組で登録する。公開鍵で失敗したら秘密鍵へ進まない
		if (name === "VAPID_PUBLIC_KEY") break;
	}
}
if (failed > 0) process.exit(1);
