/**
 * stagingの通し試験(02 #34・docs/10 §4・LAT-106)のPlaywright設定。APIレベルのみ(ブラウザ不要)。
 * 手元のE2E(playwright.config.ts・e2e/)とは別の置き場(staging-e2e/)で、wrangler devを起動しない。
 * 必ず包み(scripts/staging-e2e.mjs)から起動する: 包みが宛先・実行の印・実行の記録を渡し、
 * 出力の宛先のURL・ホスト名・通行証を伏せ、試験の前後に後始末(試験用の利用者の退会)を行う。
 * - 宛先: LATCH_LOAD_BASE_URL(無ければLATCH_STAGING_URL)。tools/load(負荷試験)と同じ名前
 * - Cloudflare Accessの通行証: LATCH_ACCESS_CLIENT_ID・LATCH_ACCESS_CLIENT_SECRET(両方あるときだけ付ける)
 * 報告はlistだけにし(HTMLの報告・トレースは宛先を含むため作らない)、実行の生成物は
 * gitの管理外の.wrangler/staging-e2e/に置く
 */

import { defineConfig } from "@playwright/test";

const baseURL = (
	process.env.LATCH_LOAD_BASE_URL ||
	process.env.LATCH_STAGING_URL ||
	""
).replace(/\/+$/, "");

const id = process.env.LATCH_ACCESS_CLIENT_ID;
const secret = process.env.LATCH_ACCESS_CLIENT_SECRET;
const access: Record<string, string> =
	id && secret
		? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }
		: {};

export default defineConfig({
	testDir: "./staging-e2e",
	// 直列に流す(stagingの候補検索を試験どうしで汚さず、本物のAIの呼び出しを数える)
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: ".wrangler/staging-e2e/test-results",
	use: {
		baseURL,
		extraHTTPHeaders: access,
		trace: "off",
	},
});
