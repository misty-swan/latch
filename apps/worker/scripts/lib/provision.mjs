/**
 * Cloudflare資源の作成の共有部(staging=F8b設計 §1.2・prod=F10・docs/04 §6)。何度実行しても
 * 同じ結果になる: 既にある資源は作らずIDを読み出し、無いものだけ作る。
 * provision-staging.mjs・provision-prod.mjsが資源名とwrangler.jsoncの区画名を渡して呼ぶ。
 *   --dry-run  作らず、作る予定だけ表示(読み取りのみ)
 *   --write    D1とKVのIDをwrangler.jsoncの区画(env.<envName>)へ書き込む
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { workerDir } from "./test-fixtures.mjs";
import { parseJsonOutput, wranglerOk } from "./wrangler-cli.mjs";

/** Vectorizeのメタデータ索引(docs/07 §1) */
const METADATA_INDEXES = ["form", "status", "category"];

/**
 * @param {object} opts
 * @param {string} opts.envName wrangler.jsoncの区画名(staging・production)
 * @param {{d1: string, kvRevocation: string, kvPipeline: string, r2: string, vectorize: string, queues: string[]}} opts.names
 *   資源名(queuesは[主キュー, DLQ]の順)
 * @param {string[]} opts.argv コマンドライン引数
 */
export function provision({ envName, names, argv }) {
	const dryRun = argv.includes("--dry-run");
	const writeConfig = argv.includes("--write");

	/** 作った/作る予定を表示する */
	const say = (text) => console.log(text);

	// --- 既存の調べ(読み取りのみ) ---
	const listD1 = () =>
		parseJsonOutput(wranglerOk(["d1", "list", "--json"]).stdout);
	const listKv = () =>
		parseJsonOutput(wranglerOk(["kv", "namespace", "list"]).stdout);
	const listR2 = () =>
		[
			...wranglerOk(["r2", "bucket", "list"]).stdout.matchAll(
				/^name:\s+(\S+)/gm,
			),
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
	let d1 = listD1().find((d) => d.name === names.d1);
	if (!d1) {
		if (create(`D1 ${names.d1}`, ["d1", "create", names.d1])) {
			d1 = listD1().find((d) => d.name === names.d1);
		}
	} else say(`既存: D1 ${names.d1}`);

	// KV(作成後に一覧で読み直してIDを得る)
	const kvIds = {};
	for (const title of [names.kvRevocation, names.kvPipeline]) {
		let ns = listKv().find((k) => k.title === title);
		if (!ns) {
			if (create(`KV ${title}`, ["kv", "namespace", "create", title])) {
				ns = listKv().find((k) => k.title === title);
			}
		} else say(`既存: KV ${title}`);
		kvIds[title] = ns?.id;
	}

	// R2
	if (!listR2().includes(names.r2)) {
		create(`R2 ${names.r2}`, ["r2", "bucket", "create", names.r2]);
	} else say(`既存: R2 ${names.r2}`);

	// Vectorize(本体→メタデータ索引。索引は本体が既にあるときだけ既存分を調べる)
	const vecExists = listVectorize().some((v) => v.name === names.vectorize);
	if (!vecExists) {
		const made = create(`Vectorize ${names.vectorize}(1024次元・cosine)`, [
			"vectorize",
			"create",
			names.vectorize,
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
					names.vectorize,
					"--propertyName",
					prop,
					"--type",
					"string",
				]);
				say(`作成: Vectorize メタデータ索引 ${prop}`);
			} else say(`[dry-run] 作成予定: Vectorize メタデータ索引 ${prop}`);
		}
	} else {
		say(`既存: Vectorize ${names.vectorize}`);
		const have = new Set(
			[
				...wranglerOk([
					"vectorize",
					"list-metadata-index",
					names.vectorize,
					"--json",
				]).stdout.matchAll(/"propertyName":\s*"(\w+)"/g),
			].map((m) => m[1]),
		);
		for (const prop of METADATA_INDEXES) {
			if (have.has(prop)) continue;
			create(`Vectorize メタデータ索引 ${prop}`, [
				"vectorize",
				"create-metadata-index",
				names.vectorize,
				"--propertyName",
				prop,
				"--type",
				"string",
			]);
		}
	}

	// Queues(DLQを先に作る)
	const queueNames = listQueues();
	for (const q of [...names.queues].reverse()) {
		if (!queueNames.includes(q)) create(`Queue ${q}`, ["queues", "create", q]);
		else say(`既存: Queue ${q}`);
	}

	// --- IDの表示と書き込み ---
	const ids = {
		d1: d1?.uuid,
		revocation: kvIds[names.kvRevocation],
		pipeline: kvIds[names.kvPipeline],
	};
	say("");
	say(`D1 uuid (${names.d1}): ${ids.d1 ?? "(未作成)"}`);
	say(`KV id (${names.kvRevocation}): ${ids.revocation ?? "(未作成)"}`);
	say(`KV id (${names.kvPipeline}): ${ids.pipeline ?? "(未作成)"}`);

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
		set(["env", envName, "d1_databases", 0, "database_id"], ids.d1);
		set(["env", envName, "kv_namespaces", 0, "id"], ids.revocation);
		set(["env", envName, "kv_namespaces", 1, "id"], ids.pipeline);
		writeFileSync(file, text);
		say(`wrangler.jsoncのenv.${envName}へIDを書き込みました`);
	}
}
