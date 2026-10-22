/**
 * staging用Cloudflare資源の作成(F8b設計 §1.2・docs/04 §6)。何度実行しても同じ結果になる:
 * 既にある資源は作らずIDを読み出し、無いものだけ作る。
 *   node scripts/provision-staging.mjs            # 無いものを作り、IDを表示
 *   node scripts/provision-staging.mjs --dry-run  # 作らず、作る予定だけ表示(読み取りのみ)
 *   node scripts/provision-staging.mjs --write     # IDをwrangler.jsoncのenv.stagingへ書き込む
 * 資源名は-staging付き(既存資源に触れない)。IDは秘密ではないためコミットしてよい。
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { workerDir } from "./lib/test-fixtures.mjs";
import { parseJsonOutput, wranglerOk } from "./lib/wrangler-cli.mjs";

const dryRun = process.argv.includes("--dry-run");
const writeConfig = process.argv.includes("--write");

const NAMES = {
	d1: "latch-db-staging",
	kvRevocation: "latch-revocation-staging",
	kvPipeline: "latch-pipeline-staging",
	r2: "latch-icons-staging",
	vectorize: "latch-intents-staging",
	queues: ["match-events-staging", "match-events-dlq-staging"],
};
/** Vectorizeのメタデータ索引(docs/07 §1) */
const METADATA_INDEXES = ["form", "status", "category"];

/** 作った/作る予定を表示する */
const say = (text) => console.log(text);

// --- 既存の調べ(読み取りのみ) ---
const listD1 = () =>
	parseJsonOutput(wranglerOk(["d1", "list", "--json"]).stdout);
const listKv = () =>
	parseJsonOutput(wranglerOk(["kv", "namespace", "list"]).stdout);
const listR2 = () =>
	[
		...wranglerOk(["r2", "bucket", "list"]).stdout.matchAll(/^name:\s+(\S+)/gm),
	].map((m) => m[1]);
const listVectorize = () =>
	parseJsonOutput(wranglerOk(["vectorize", "list", "--json"]).stdout);
/** 表の罫線で囲まれた行の2列目(name)を拾う */
const listQueues = () =>
	[
		...wranglerOk(["queues", "list"]).stdout.matchAll(
			/^│\s*[0-9a-f]{32}\s*│\s*(\S+)\s*│/gm,
		),
	].map((m) => m[1]);

/** 作る(dry-runでは作らず予定だけ表示) */
function create(label, args) {
	if (dryRun) {
		say(`[dry-run] 作成予定: ${label}`);
		return false;
	}
	wranglerOk(args);
	say(`作成: ${label}`);
	return true;
}

// D1
let d1 = listD1().find((d) => d.name === NAMES.d1);
if (!d1) {
	if (create(`D1 ${NAMES.d1}`, ["d1", "create", NAMES.d1])) {
		d1 = listD1().find((d) => d.name === NAMES.d1);
	}
} else say(`既存: D1 ${NAMES.d1}`);

// KV(作成後に一覧で読み直してIDを得る)
const kvIds = {};
for (const title of [NAMES.kvRevocation, NAMES.kvPipeline]) {
	let ns = listKv().find((k) => k.title === title);
	if (!ns) {
		if (create(`KV ${title}`, ["kv", "namespace", "create", title])) {
			ns = listKv().find((k) => k.title === title);
		}
	} else say(`既存: KV ${title}`);
	kvIds[title] = ns?.id;
}

// R2
if (!listR2().includes(NAMES.r2)) {
	create(`R2 ${NAMES.r2}`, ["r2", "bucket", "create", NAMES.r2]);
} else say(`既存: R2 ${NAMES.r2}`);

// Vectorize(本体→メタデータ索引。索引は本体が既にあるときだけ既存分を調べる)
const vecExists = listVectorize().some((v) => v.name === NAMES.vectorize);
if (!vecExists) {
	const made = create(`Vectorize ${NAMES.vectorize}(1024次元・cosine)`, [
		"vectorize",
		"create",
		NAMES.vectorize,
		"--dimensions",
		"1024",
		"--metric",
		"cosine",
	]);
	for (const prop of METADATA_INDEXES) {
		if (made) {
			wranglerOk([
				"vectorize",
				"create-metadata-index",
				NAMES.vectorize,
				"--propertyName",
				prop,
				"--type",
				"string",
			]);
			say(`作成: Vectorize メタデータ索引 ${prop}`);
		} else say(`[dry-run] 作成予定: Vectorize メタデータ索引 ${prop}`);
	}
} else {
	say(`既存: Vectorize ${NAMES.vectorize}`);
	const have = new Set(
		[
			...wranglerOk([
				"vectorize",
				"list-metadata-index",
				NAMES.vectorize,
				"--json",
			]).stdout.matchAll(/"propertyName":\s*"(\w+)"/g),
		].map((m) => m[1]),
	);
	for (const prop of METADATA_INDEXES) {
		if (have.has(prop)) continue;
		create(`Vectorize メタデータ索引 ${prop}`, [
			"vectorize",
			"create-metadata-index",
			NAMES.vectorize,
			"--propertyName",
			prop,
			"--type",
			"string",
		]);
	}
}

// Queues(DLQを先に作る)
const queueNames = listQueues();
for (const q of [...NAMES.queues].reverse()) {
	if (!queueNames.includes(q)) create(`Queue ${q}`, ["queues", "create", q]);
	else say(`既存: Queue ${q}`);
}

// --- IDの表示と書き込み ---
const ids = {
	d1: d1?.uuid,
	revocation: kvIds[NAMES.kvRevocation],
	pipeline: kvIds[NAMES.kvPipeline],
};
say("");
say(`D1 uuid (${NAMES.d1}): ${ids.d1 ?? "(未作成)"}`);
say(`KV id (${NAMES.kvRevocation}): ${ids.revocation ?? "(未作成)"}`);
say(`KV id (${NAMES.kvPipeline}): ${ids.pipeline ?? "(未作成)"}`);

if (writeConfig) {
	if (dryRun || !ids.d1 || !ids.revocation || !ids.pipeline) {
		console.error("IDが揃っていないため、wrangler.jsoncは書き換えません");
		process.exit(1);
	}
	const file = path.join(workerDir, "wrangler.jsonc");
	let text = readFileSync(file, "utf8");
	const fmt = { formattingOptions: { insertSpaces: false, tabSize: 1 } };
	const set = (jsonPath, value) => {
		text = applyEdits(text, modify(text, jsonPath, value, fmt));
	};
	set(["env", "staging", "d1_databases", 0, "database_id"], ids.d1);
	set(["env", "staging", "kv_namespaces", 0, "id"], ids.revocation);
	set(["env", "staging", "kv_namespaces", 1, "id"], ids.pipeline);
	writeFileSync(file, text);
	say("wrangler.jsoncのenv.stagingへIDを書き込みました");
}
