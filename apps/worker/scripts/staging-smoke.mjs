/**
 * stagingの疎通確認(F8b設計 §2.1)。LATCH_STAGING_URL(無ければLATCH_LOAD_BASE_URL)へ
 *   GET /healthz = 200
 *   POST /v1/dev/idp-token {"subject":"load-smoke"} = 200
 * を確かめ、外れたら非0で終わる。URLは標準出力にも誤りメッセージにも出さない
 * (stagingのURLは文書・設定・ログに残さない・設計 §2.1)。
 */

const base = (
	process.env.LATCH_STAGING_URL ||
	process.env.LATCH_LOAD_BASE_URL ||
	""
).replace(/\/+$/, "");

if (!base) {
	console.error("LATCH_STAGING_URL(またはLATCH_LOAD_BASE_URL)が未設定です");
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
		console.log(`OK: ${label}`);
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
			body: JSON.stringify({ subject: "load-smoke" }),
		},
		200,
	),
];
process.exit(results.every(Boolean) ? 0 : 1);
