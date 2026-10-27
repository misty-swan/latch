/**
 * prodの疎通確認(F10・docs/11 §1・§2・docs/runbooks/prod.md 5章)。LATCH_PROD_URLへ
 *   GET /healthz = 200(起動ガードを通った=テスト鍵・テスト用VAPID鍵・仮の送信者が無い)
 *   POST /v1/dev/idp-token = 404(テスト用サインインの入口がprodに無い・docs/10 §2)
 * を確かめ、外れたら非0で終わる。URLは標準出力にも誤りメッセージにも出さない。
 * 起動ガードに拒まれたWorkerは全要求に500を返すため、/healthzの200で通ったことが分かる。
 */

const base = (process.env.LATCH_PROD_URL || "").replace(/\/+$/, "");

if (!base) {
	console.error("LATCH_PROD_URLが未設定です");
	process.exit(1);
}

/** 1回の確認。通信エラーはURLを含み得るため名前だけ出す */
async function check(label, path, init, expected) {
	try {
		const res = await fetch(`${base}${path}`, init);
		if (res.status !== expected) {
			console.error(`NG: ${label}(期待${expected}・実際${res.status})`);
			return false;
		}
		console.log(`OK: ${label}(${expected})`);
		return true;
	} catch (e) {
		console.error(`NG: ${label}(通信エラー: ${e?.name ?? "Error"})`);
		return false;
	}
}

const results = [
	await check("GET /healthz", "/healthz", undefined, 200),
	await check(
		"POST /v1/dev/idp-token",
		"/v1/dev/idp-token",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject: "prod-smoke" }),
		},
		404,
	),
];
process.exit(results.every(Boolean) ? 0 : 1);
