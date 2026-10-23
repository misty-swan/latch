/**
 * 負荷試験の後始末(F8b設計 §3.2)。stagingのD1から「意思を持つ`load-`の利用者」を
 * 読み取りの問い合わせ(SELECT)で探し、その利用者としてテスト用サインインで入り直して
 * GET /v1/intents(全頁)→DELETE /v1/intents/{id}で意思を消す。
 * SQLで状態だけを書き換えるとVectorizeのベクトルが残り、次の回のLayer 2 Candidate
 * Retrievalを汚すため、ベクトルを先に消す削除APIを通す。
 * 実行の印(runId)を問わず`load-`の利用者を全員拾う(途中で止まった回の残りも消す)。
 * 1人の失敗(サインイン・一覧・削除)で全体を止めず、残りの利用者を続けて処理し、
 * 最後に失敗が1件でもあれば0以外で終わる。
 *
 * 使い方: LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/cleanup.mjs
 * stagingのURLは標準出力にも誤りメッセージにも出さない(設計 §2.1)。
 */

import { pathToFileURL } from "node:url";
import {
	parseJsonOutput,
	redactUrls,
	wranglerOk,
} from "../../apps/worker/scripts/lib/wrangler-cli.mjs";

/** 意思を持つ`load-`の利用者(読み取りのみ) */
export const SUBJECTS_SQL =
	"SELECT DISTINCT u.auth_subject FROM users u JOIN intents i ON i.user_id = u.id WHERE u.auth_subject LIKE 'load-%'";

/** 問い合わせの行から`load-`で始まるsubjectだけを重複なく返す(LIKEの念押し) */
export function subjectsWithIntents(rows) {
	const subjects = [];
	for (const row of rows) {
		const subject = row?.auth_subject;
		if (
			typeof subject === "string" &&
			subject.startsWith("load-") &&
			!subjects.includes(subject)
		) {
			subjects.push(subject);
		}
	}
	return subjects;
}

/** stagingのD1へSELECTを送り、結果の行を返す */
function querySubjects() {
	const r = wranglerOk([
		"d1",
		"execute",
		"DB",
		"--env",
		"staging",
		"--remote",
		"--json",
		"--command",
		SUBJECTS_SQL,
	]);
	const out = parseJsonOutput(r.stdout);
	return Array.isArray(out) ? (out[0]?.results ?? []) : (out.results ?? []);
}

/** 1回の要求の時間切れ(ミリ秒)。stagingで1回の削除が長引いても全体が止まらないようにする */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 時間切れのとき同じ要求をやり直す最大回数(初回は数えない) */
export const TIMEOUT_RETRIES = 3;

/**
 * 1回のAPI呼び出し。通信エラーはURLを含み得るため名前だけを出す。
 * 時間切れ(既定30秒)なら同じ要求を最大3回までやり直し、それでもだめなら例外にする
 * (削除・一覧・サインインは再実行しても結果が同じ)。fetchImpl・timeoutMsは試験用の差し替え口
 */
export async function call(
	base,
	method,
	path,
	{
		token,
		body,
		fetchImpl = fetch,
		timeoutMs = REQUEST_TIMEOUT_MS,
		retries = TIMEOUT_RETRIES,
	} = {},
) {
	const headers = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	let res;
	for (let attempt = 0; ; attempt += 1) {
		try {
			res = await fetchImpl(`${base}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			break;
		} catch (e) {
			const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
			if (timedOut && attempt < retries) continue;
			throw new Error(
				`${method} ${path.split("?")[0]}: ${
					timedOut
						? `時間切れ(${attempt + 1}回試行)`
						: `通信エラー(${e?.name ?? "Error"})`
				}`,
			);
		}
	}
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text === "" ? null : JSON.parse(text);
	} catch {
		// JSONでない応答(上流の誤りページ等)は状態コードだけで判断する
	}
	return { status: res.status, json: parsed };
}

/** subjectとして入り直し、登録済みの利用者のaccess_tokenを返す */
async function signInExisting(base, subject, opts) {
	const idp = await call(base, "POST", "/v1/dev/idp-token", {
		...opts,
		body: { subject },
	});
	if (idp.status !== 200) {
		throw new Error(
			`宛先がstagingではありません(dev専用サインインが${idp.status})`,
		);
	}
	const auth = await call(base, "POST", "/v1/auth/token", {
		...opts,
		body: { provider: "google", idp_token: idp.json.idp_token },
	});
	if (auth.status !== 200 || auth.json?.registration_required !== false) {
		throw new Error(`サインインに失敗しました(${auth.status})`);
	}
	return auth.json.access_token;
}

/** 本人の意思のidを全頁から集める */
async function listIntentIds(base, token, opts) {
	const ids = [];
	let cursor = null;
	do {
		const q = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
		const page = await call(base, "GET", `/v1/intents?limit=50${q}`, {
			...opts,
			token,
		});
		if (page.status !== 200) {
			throw new Error(`GET /v1/intents が${page.status}`);
		}
		for (const item of page.json.items) ids.push(item.id);
		cursor = page.json.next_cursor;
	} while (cursor !== null);
	return ids;
}

/**
 * 利用者ごとに後始末を行い、件数を数える(純粋な繰り返し部・cleanOneを差し替えて試験する)。
 * cleanOne(subject)は{deleted, failed}を返す。例外を投げた利用者は失敗1件として数え、
 * 次の利用者へ進む。誤りの文はURLを伏せてonErrorへ渡す
 * @param {string[]} subjects
 * @param {(subject: string) => Promise<{ deleted: number, failed: number }>} cleanOne
 * @param {(message: string) => void} onError
 */
export async function cleanupSubjects(subjects, cleanOne, onError = () => {}) {
	let deleted = 0;
	let failed = 0;
	let failedUsers = 0;
	for (const subject of subjects) {
		try {
			const r = await cleanOne(subject);
			deleted += r.deleted;
			failed += r.failed;
		} catch (e) {
			failed += 1;
			failedUsers += 1;
			onError(redactUrls(String(e?.message ?? e)));
		}
	}
	return { deleted, failed, failedUsers };
}

/**
 * 1人分: 入り直して意思を全件消す。404は他の後始末と重なって既に消えた場合。
 * 時間切れで通らなかった意思(やり直しの後も)は残して次の意思へ進み、failedに数える。
 * opts.fetchImpl・timeoutMsは試験用、onErrorは誤りの文(URL伏せ済み)の出し先
 */
export async function cleanOneSubject(base, subject, opts = {}) {
	const { onError = (m) => console.error(m), ...callOpts } = opts;
	const token = await signInExisting(base, subject, callOpts);
	let deleted = 0;
	let failed = 0;
	for (const id of await listIntentIds(base, token, callOpts)) {
		try {
			const r = await call(base, "DELETE", `/v1/intents/${id}`, {
				...callOpts,
				token,
			});
			if (r.status === 204 || r.status === 404) {
				deleted += 1;
			} else {
				failed += 1;
				onError(`cleanup: DELETE /v1/intents/{id} が${r.status}`);
			}
		} catch (e) {
			failed += 1;
			onError(
				`cleanup: 意思を残して次へ進みます(${redactUrls(String(e?.message ?? e))})`,
			);
		}
	}
	return { deleted, failed };
}

async function main() {
	const base = (
		process.env.LATCH_LOAD_BASE_URL ||
		process.env.LATCH_STAGING_URL ||
		""
	).replace(/\/+$/, "");
	if (!base) {
		console.error("LATCH_LOAD_BASE_URL(またはLATCH_STAGING_URL)が未設定です");
		process.exit(1);
	}

	const subjects = subjectsWithIntents(querySubjects());
	console.log(`cleanup: 意思を持つload-の利用者 ${subjects.length}人`);
	const { deleted, failed, failedUsers } = await cleanupSubjects(
		subjects,
		(subject) => cleanOneSubject(base, subject),
		(message) =>
			console.error(`cleanup: 1人の後始末に失敗しました(${message})`),
	);
	console.log(
		`cleanup: 意思を${deleted}件削除しました(残った意思・失敗${failed}件・うち途中で止まった利用者${failedUsers}人)`,
	);
	if (failed > 0) process.exit(1);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((e) => {
		console.error(`cleanup: ${redactUrls(String(e?.message ?? e))}`);
		process.exit(1);
	});
}
