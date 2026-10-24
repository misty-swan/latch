/**
 * シナリオ(a) 作成の集中(F8b設計 §3.3・docs/10 §5)。
 * 読み解き(parse)→保存(POST /v1/intents・status=active)を合計100件/分で5分間繰り返す
 * (100人×5件。1人のActive Intent上限5件に収まる)。読み解き確認の[預ける]と同じ呼び方。
 * k6が測るもの: Intent保存のp95(目標0.5秒)・Parserのp95(目標3秒・LLMの動作は計測時の設定による)。
 *
 * 実行(手順書 docs/runbooks/staging.md 7章。k6の出力のURLを伏せる包みrun.mjsを通す):
 *   LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/run.mjs tools/load/scenarios/a-intent-burst.js \
 *     -e RUN_ID=<YYYYMMDDHHmm> --summary-export tools/load/results/<RUN_ID>-a.json
 * LOAD_SCALE(既定1)はrate・人数・時間に掛ける倍率(試しは0.1=10件/分を30秒)。
 */

import { check } from "k6";
import exec from "k6/execution";
import {
	ensureTarget,
	loadConfig,
	parseIntent,
	runIdFromEnv,
	saveIntent,
	signIn,
} from "../lib/api.js";
import { bodyFromParse, scaled } from "../lib/target.mjs";
import { TOPICS } from "../lib/topics.js";

/** 1人のActive Intent上限(LIMITS.ACTIVE_INTENTS_PER_USER・docs/05 §3.1) */
const INTENTS_PER_USER = 5;

const config = loadConfig();
const users = scaled(100, config.scale);

export const options = {
	setupTimeout: "10m",
	scenarios: {
		intent_burst: {
			executor: "constant-arrival-rate",
			rate: scaled(100, config.scale),
			timeUnit: "1m",
			duration: `${scaled(300, config.scale)}s`,
			preAllocatedVUs: scaled(20, config.scale),
		},
	},
	thresholds: {
		"http_req_duration{name:intent_save}": ["p(95)<500"],
		"http_req_duration{name:parse}": ["p(95)<3000"],
		http_req_failed: ["rate<0.01"],
	},
};

export function setup() {
	ensureTarget(config.baseUrl);
	const runId = runIdFromEnv();
	const tokens = [];
	for (let n = 1; n <= users; n += 1) {
		tokens.push(signIn(config.baseUrl, `load-${runId}-${n}`));
	}
	return { runId, tokens };
}

export default function (data) {
	const i = exec.scenario.iterationInTest;
	// 反復ごとに1人を順に使い、1人の作成は上限の5件まで(超える分は何もしない)
	if (Math.floor(i / data.tokens.length) >= INTENTS_PER_USER) return;
	const token = data.tokens[i % data.tokens.length];
	const rawText = TOPICS[i % TOPICS.length];

	const parsed = parseIntent(config.baseUrl, token, rawText);
	if (!check(parsed, { parseが200: (r) => r.status === 200 })) return;
	const body = bodyFromParse(parsed.json(), rawText);
	if (!check(body, { 保存の本文を組み立てられる: (b) => b !== null })) return;

	const saved = saveIntent(config.baseUrl, token, body);
	check(saved, { 保存が201: (r) => r.status === 201 });
}
