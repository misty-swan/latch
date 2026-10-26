/**
 * stagingの通し試験(02 #34・docs/10 §4・LAT-106)の包み。次の順に動く。
 * 1. 前の回の残り(実行の記録に残った試験用の利用者)を退会させる
 * 2. 宛先の確認(dev専用サインインが200でなければ中止。prodは404)
 * 3. 外部送信(本物のAI)の当日の回数を控える(GET /v1/dev/usage・05 §3.3)
 * 4. Playwright(playwright.staging.config.ts)を流し、標準出力・標準エラーの宛先のURL・
 *    ホスト名・workers.devのURL・Accessの通行証を伏せて出す(tools/load/lib/redact.mjs)
 * 5. 外部送信の回数の増分を出す(同じ日に他の利用があればその分も入る)
 * 6. この回の試験用の利用者を全員退会させる(意思はベクトルごと消える・05 §2.5)。
 *    Playwrightの生成物(.wrangler/staging-e2e/test-results)は宛先を含みうるため消す
 * 終了コードはPlaywrightのもの(後始末に失敗したら1)。
 *
 * 使い方(apps/workerで):
 *   LATCH_LOAD_BASE_URL=<stagingのURL> LATCH_ACCESS_CLIENT_ID=… LATCH_ACCESS_CLIENT_SECRET=… \
 *     node scripts/staging-e2e.mjs [Playwrightの引数...]
 *   LATCH_E2E_PORT=<空きポート> node scripts/staging-e2e.mjs --local   # 手元のwrangler dev(stub)へ試運転
 *   node scripts/staging-e2e.mjs --cleanup-only                          # 残りの後始末だけ
 * --localは、手元の状態の置き場(.wrangler/staging-e2e-state・手元のE2Eとも手元開発とも別)へ
 * マイグレーションを適用してwrangler dev --localを起動し、宛先をそこへ向ける(Cronの強制発火は使わない)。
 * 試験用の利用者のsubjectは`stg-e2e-<実行の印>-<役>-<乱数>`で、レート制限の緩和(stagingは`load-`
 * だけ)を受けない。試験は観測をレート制限の対象外のdev専用APIで待つため、制限の内に収まる
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { call } from "../../../tools/load/cleanup.mjs";
import { createLineRedactor, redact } from "../../../tools/load/lib/redact.mjs";
import { runIdNow } from "../../../tools/load/lib/target.mjs";

const workerDir = path.join(import.meta.dirname, "..");
const workDir = path.join(workerDir, ".wrangler", "staging-e2e");
const runsDir = path.join(workDir, "runs");
const localState = ".wrangler/staging-e2e-state";

const args = process.argv.slice(2);
const local = args.includes("--local");
const cleanupOnly = args.includes("--cleanup-only");
const playwrightArgs = args.filter(
	(a) => a !== "--local" && a !== "--cleanup-only",
);

const port = process.env.LATCH_E2E_PORT;
if (local && !port) {
	console.error("--localではLATCH_E2E_PORT(空きポート)を指定してください");
	process.exit(1);
}
const base = (
	local
		? `http://localhost:${port}`
		: process.env.LATCH_LOAD_BASE_URL || process.env.LATCH_STAGING_URL || ""
).replace(/\/+$/, "");
if (!base) {
	console.error(
		"LATCH_LOAD_BASE_URL(またはLATCH_STAGING_URL)が未設定です(手元へ試運転するときは--local)",
	);
	process.exit(1);
}
const secrets = [
	process.env.LATCH_ACCESS_CLIENT_ID,
	process.env.LATCH_ACCESS_CLIENT_SECRET,
].filter(Boolean);
const say = (line) => console.log(redact(line, base, secrets));
const sayError = (line) => console.error(redact(line, base, secrets));

/** subjectとして入り直す。未登録(退会済み)ならnull */
async function signIn(subject) {
	const idp = await call(base, "POST", "/v1/dev/idp-token", {
		body: { subject },
	});
	if (idp.status !== 200) {
		throw new Error(
			`宛先がstagingではありません(dev専用サインインが${idp.status})`,
		);
	}
	const auth = await call(base, "POST", "/v1/auth/token", {
		body: { provider: "google", idp_token: idp.json.idp_token },
	});
	if (auth.status !== 200) {
		throw new Error(`サインインに失敗しました(${auth.status})`);
	}
	return auth.json.registration_required ? null : auth.json.access_token;
}

/** 1人を退会させる(本人の再認証のIdPトークンを添える)。退会済みならfalse */
async function withdraw(subject) {
	const token = await signIn(subject);
	if (token === null) return false;
	const idp = await call(base, "POST", "/v1/dev/idp-token", {
		body: { subject },
	});
	const res = await call(base, "DELETE", "/v1/users/me", {
		token,
		body: { provider: "google", idp_token: idp.json.idp_token },
	});
	if (res.status !== 204) {
		throw new Error(`DELETE /v1/users/me が${res.status}`);
	}
	return true;
}

/** 実行の記録のsubjectを全員退会させる。全員済んだ記録は消す。失敗の件数を返す */
async function cleanup() {
	if (!existsSync(runsDir)) return 0;
	let failed = 0;
	for (const name of readdirSync(runsDir).filter((n) => n.endsWith(".jsonl"))) {
		const file = path.join(runsDir, name);
		const subjects = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l).subject);
		let withdrawn = 0;
		let fileFailed = 0;
		for (const subject of subjects) {
			try {
				if (await withdraw(subject)) withdrawn += 1;
			} catch (e) {
				fileFailed += 1;
				sayError(`後始末: 1人の退会に失敗しました(${String(e?.message ?? e)})`);
			}
		}
		say(
			`後始末: 記録${name}の利用者${subjects.length}人のうち${withdrawn}人を退会させました(試験の中で退会済み・未登録${subjects.length - withdrawn - fileFailed}人・失敗${fileFailed}人)`,
		);
		if (fileFailed === 0) unlinkSync(file);
		failed += fileFailed;
	}
	return failed;
}

/** JSTの今日(YYYY-MM-DD)。外部送信の集計の日付(08 §5) */
const jstToday = () =>
	new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 外部送信の当日の回数(宛先:用途ごと) */
async function usage(token) {
	const res = await call(base, "GET", `/v1/dev/usage?date=${jstToday()}`, {
		token,
	});
	if (res.status !== 200) throw new Error(`GET /v1/dev/usage が${res.status}`);
	return res.json.counts;
}

/** 回数を控える利用者を作る(試験用の利用者と同じく実行の記録に書き、最後に退会させる) */
async function usageUser(runId, record) {
	const subject = `stg-e2e-${runId}-usage-${crypto.randomUUID().slice(0, 8)}`;
	writeFileSync(record, `${JSON.stringify({ subject })}\n`, { flag: "a" });
	const idp = await call(base, "POST", "/v1/dev/idp-token", {
		body: { subject },
	});
	const auth = await call(base, "POST", "/v1/auth/token", {
		body: { provider: "google", idp_token: idp.json.idp_token },
	});
	const reg = await call(base, "POST", "/v1/users", {
		token: auth.json.access_token,
		body: { display_name: "通し試験の計数", birth_date: "2000-01-01", bio: "" },
	});
	if (reg.status !== 201) throw new Error(`POST /v1/users が${reg.status}`);
	return reg.json.access_token;
}

/** 手元のwrangler dev(stub)を起動し、/healthzが200になるまで待つ */
async function startLocal() {
	for (const cmd of [
		["node", ["scripts/prepare-dev-vars.mjs"]],
		[
			"pnpm",
			[
				"exec",
				"wrangler",
				"d1",
				"migrations",
				"apply",
				"DB",
				"--local",
				"--persist-to",
				localState,
			],
		],
	]) {
		const r = spawnSync(cmd[0], cmd[1], { cwd: workerDir, stdio: "ignore" });
		if (r.status !== 0) throw new Error(`${cmd[1].join(" ")} が失敗しました`);
	}
	const logFd = openSync(path.join(workDir, "wrangler-dev.log"), "w");
	const child = spawn(
		"pnpm",
		[
			"exec",
			"wrangler",
			"dev",
			"--local",
			"--persist-to",
			localState,
			"--port",
			port,
		],
		{ cwd: workerDir, stdio: ["ignore", logFd, logFd], detached: true },
	);
	const deadline = Date.now() + 120_000;
	for (;;) {
		try {
			if ((await fetch(`${base}/healthz`)).status === 200) return child;
		} catch {
			// 起動を待つ
		}
		if (Date.now() >= deadline) {
			process.kill(-child.pid);
			throw new Error(
				"手元のwrangler devが起動しません(.wrangler/staging-e2e/wrangler-dev.log)",
			);
		}
		await new Promise((r) => setTimeout(r, 1_000));
	}
}

/** Playwrightを流し、出力を伏せて出す。終了コードを返す */
function runPlaywright(env) {
	return new Promise((resolve) => {
		const child = spawn(
			"pnpm",
			[
				"exec",
				"playwright",
				"test",
				"-c",
				"playwright.staging.config.ts",
				...playwrightArgs,
			],
			{
				cwd: workerDir,
				env,
				stdio: ["inherit", "pipe", "pipe"],
			},
		);
		const out = createLineRedactor(
			base,
			(s) => process.stdout.write(s),
			secrets,
		);
		const err = createLineRedactor(
			base,
			(s) => process.stderr.write(s),
			secrets,
		);
		child.stdout.setEncoding("utf8").on("data", (c) => out.push(c));
		child.stderr.setEncoding("utf8").on("data", (c) => err.push(c));
		child.on("error", (e) => {
			sayError(`Playwrightを起動できません(${e.code ?? e.name})`);
			resolve(1);
		});
		child.on("close", (code) => {
			out.end();
			err.end();
			resolve(code ?? 1);
		});
	});
}

async function main() {
	mkdirSync(runsDir, { recursive: true });
	const server = local ? await startLocal() : null;
	say(
		`宛先: ${local ? `手元のwrangler dev(ポート${port}・stub)` : "環境変数の宛先(URLは伏せる)"}`,
	);
	let code = 1;
	try {
		const leftovers = await cleanup();
		if (cleanupOnly) return leftovers === 0 ? 0 : 1;
		const runId = runIdNow();
		const record = path.join(runsDir, `${runId}.jsonl`);
		say(`実行の印: ${runId}`);
		const counter = await usageUser(runId, record);
		const before = await usage(counter);
		const started = Date.now();
		code = await runPlaywright({
			...process.env,
			LATCH_LOAD_BASE_URL: base,
			LATCH_STAGING_E2E_RUN_ID: runId,
			LATCH_STAGING_E2E_RECORD: record,
			FORCE_COLOR: "0",
		});
		// Playwrightの生成物(失敗の文脈のファイル)は通信の誤りの文に宛先を含みうるため残さない
		// (内容は伏せた出力に出ている)
		rmSync(path.join(workDir, "test-results"), {
			recursive: true,
			force: true,
		});
		say(`所要時間: ${Math.round((Date.now() - started) / 60_000)}分`);
		try {
			const after = await usage(counter);
			const keys = [
				...new Set([...Object.keys(before), ...Object.keys(after)]),
			].sort();
			say(
				`外部送信の回数(この回の増分・同じ日の他の利用を含みうる): ${
					keys
						.map((k) => `${k} ${(after[k] ?? 0) - (before[k] ?? 0)}回`)
						.join("・") || "0回"
				}`,
			);
		} catch (e) {
			// 集計に失敗しても後始末は行う
			sayError(`外部送信の回数を集計できません(${String(e?.message ?? e)})`);
		}
		if ((await cleanup()) > 0) code = code === 0 ? 1 : code;
	} finally {
		if (server !== null) process.kill(-server.pid);
	}
	return code;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		sayError(`通し試験: ${String(e?.message ?? e)}`);
		process.exit(1);
	});
