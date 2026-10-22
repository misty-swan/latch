/**
 * シナリオ(b) 作成〜提案の一連 / (d) 通知の一斉送信(F8b設計 §3.3・docs/10 §5)。
 * 2人組×30組(60人)が、組ごとに同じtopicの機会Intentをactiveで保存し、
 * 2人とも提案のアプリ内通知(type=proposal)を受け取るまで待つ。
 * 組kの意思は基準時刻(実行時刻+24時間を1時間単位に切り上げ)+k×3時間から2時間とし、
 * 組どうしはLayer 1の時間の重なりの条件で外れる(lib/pairs.mjs)。
 * - MODE=staggered((b)・既定): 組ごとに2秒間隔で投入する
 * - MODE=burst((d)): 全組がsetupの決めた同じ時刻に一斉に投入する(60件前後の提案の通知が同時に発生)
 * k6は時間を測らない。初期判定(intent_createdのイベント行→提案の通知のpush_attempted_at)と
 * 通知(通知行のcreated_at→push_attempted_at)のp95は、試験の後に集計(設計 §4.1)がD1から出す。
 * k6が出すのは提案の通知が届いた人数(proposal_delivered)と届かなかった人数(proposal_missing)。
 *
 * 実行(手順書 docs/runbooks/staging.md 7章。k6の出力のURLを伏せる包みrun.mjsを通す):
 *   LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/run.mjs tools/load/scenarios/bd-proposal.js \
 *     -e MODE=staggered -e RUN_ID=<YYYYMMDDHHmm> --summary-export tools/load/results/<RUN_ID>-b.json
 * LOAD_SCALE(既定1)は組数に掛ける倍率(30×倍率・最低1組)。PROPOSAL_WAIT_SEC(既定60)は
 * 1組の提案待ちの上限(秒)。
 */

import { sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import {
	createOccasion,
	ensureTarget,
	loadConfig,
	runIdFromEnv,
	signIn,
	waitForProposal,
} from "../lib/api.js";
import {
	BURST_LEAD_SEC,
	baseStartMs,
	maxDurationSec,
	pairStartMs,
	pairSubjects,
	parseMode,
	STAGGER_SEC,
} from "../lib/pairs.mjs";
import { scaled } from "../lib/target.mjs";
import { TOPICS } from "../lib/topics.js";

const config = loadConfig();
const mode = parseMode(__ENV.MODE);
const pairs = scaled(30, config.scale);

/** 提案の通知が届いた人数・届かなかった人数(1人1件で数える) */
const delivered = new Counter("proposal_delivered");
const missing = new Counter("proposal_missing");

export const options = {
	setupTimeout: "10m",
	scenarios: {
		[mode === "burst" ? "notify_burst" : "proposal_staggered"]: {
			executor: "per-vu-iterations",
			vus: pairs,
			iterations: 1,
			maxDuration: `${maxDurationSec(mode, pairs, config.proposalWaitSec)}s`,
		},
	},
	thresholds: {
		http_req_failed: ["rate<0.01"],
		// 全員に提案の通知が届くこと(届かない人が1人でもいれば✗)
		proposal_missing: ["count<1"],
	},
};

export function setup() {
	ensureTarget(config.baseUrl);
	const runId = runIdFromEnv();
	const groups = [];
	for (let k = 0; k < pairs; k += 1) {
		groups.push(
			pairSubjects(runId, mode, k).map((s) => signIn(config.baseUrl, s)),
		);
	}
	const now = Date.now();
	return {
		runId,
		groups,
		baseMs: baseStartMs(now),
		// (d)の一斉投入の時刻。全VUが起動してsleepに入るまでの間を置く
		burstAtMs: now + BURST_LEAD_SEC * 1_000,
	};
}

export default function (data) {
	const k = exec.vu.idInTest - 1;
	const tokens = data.groups[k];
	if (!tokens) return;

	if (mode === "burst") {
		const waitMs = data.burstAtMs - Date.now();
		if (waitMs > 0) sleep(waitMs / 1_000);
	} else {
		sleep(k * STAGGER_SEC);
	}

	const topic = TOPICS[k % TOPICS.length];
	const startMs = pairStartMs(data.baseMs, k);
	try {
		for (const token of tokens) {
			createOccasion(config.baseUrl, token, { topic, startMs });
		}
	} catch (_e) {
		// 保存の失敗はcheckとhttp_req_failedに出る。この組は届かなかったとして数える
		missing.add(tokens.length);
		return;
	}

	// 組の2人が同じ締め切りまでに提案の通知を受け取るのを待つ
	const deadline = Date.now() + config.proposalWaitSec * 1_000;
	for (const token of tokens) {
		const remainingSec = Math.max(0, (deadline - Date.now()) / 1_000);
		const found = waitForProposal(config.baseUrl, token, remainingSec);
		if (found) delivered.add(1);
		else missing.add(1);
	}
}
