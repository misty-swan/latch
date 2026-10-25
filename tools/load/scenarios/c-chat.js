/**
 * シナリオ(c) チャット同時接続(F8b設計 §3.3・docs/10 §5)。
 * 準備(setup)で1対1を50組(100人)成立させる。組の作り方は(b)と同じで、組ごとに同じtopicの
 * 機会Intentをactiveで保存し、組どうしは時間帯をずらしてLayer 1の時間の重なりの条件で外す
 * (lib/pairs.mjs。50組を7日以内に収めるため間隔は2時間)。提案のアプリ内通知が届いたら
 * 2人ともPOST /v1/latches/{id}/response {response:"yes"}で参加し、status=matchedを確かめる。
 * 本体は100人が同時にWebSocket(k6/websockets)で接続し、5分間、5秒ごとに
 * `{type:"message", body:"t=<送った時刻>", client_id:"<VU>-<連番>"}`を送り合う。25秒ごとにping。
 * k6が測るもの:
 * - chat_delivery_ms(Trend): 相手の発言の送信から到着までのミリ秒(自分の送信の折り返しは除く)
 * - chat_connect_failed(Rate): 接続の失敗(チケットの発行の失敗を含む)の割合
 * - chat_messages_sent(Counter)・chat_pairs_unmatched(Counter): 送った件数・成立できなかった組数
 *
 * 実行(手順書 docs/runbooks/staging.md 7章。k6の出力のURLを伏せる包みrun.mjsを通す):
 *   LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/run.mjs tools/load/scenarios/c-chat.js \
 *     -e RUN_ID=<YYYYMMDDHHmm> --summary-export tools/load/results/<RUN_ID>-c.json
 * LOAD_SCALE(既定1)は組数(50×倍率・最低1組・上限1.44=72組。超えると準備で止まる)と接続を保つ時間(300秒×倍率)に掛ける倍率。
 * PROPOSAL_WAIT_SEC(既定60)は提案待ちの上限(秒)で、setupTimeoutはこれから決まる。
 * WebSocketのURLは宛先のURLから作り(https→wss)、表示しない。
 */

import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { clearInterval, setInterval, setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";
import {
	accessHeadersFromEnv,
	createOccasion,
	ensureTarget,
	loadConfig,
	respondLatch,
	runIdFromEnv,
	signIn,
	waitForProposal,
	wsTicket,
} from "../lib/api.js";
import {
	chatMaxDurationSec,
	chatPlan,
	chatSetupTimeoutSec,
	chatWsUrl,
	clientId,
	deliveryMs,
	messageBody,
	PING_INTERVAL_SEC,
	SEND_INTERVAL_SEC,
} from "../lib/chat.mjs";
import {
	assertWithinStartLimit,
	baseStartMs,
	CHAT_PAIR_SPACING_MS,
	pairStartMs,
	pairSubjects,
} from "../lib/pairs.mjs";
import { TOPICS } from "../lib/topics.js";

const config = loadConfig();
const { pairs, holdSec } = chatPlan(config.scale);

const delivery = new Trend("chat_delivery_ms", true);
const connectFailed = new Rate("chat_connect_failed");
const sent = new Counter("chat_messages_sent");
const unmatched = new Counter("chat_pairs_unmatched");
// 接続の切断の記録(#46)。openの後、予定の保持時間の前に閉じた接続はこれまでどの指標にも出なかった
const closedEarly = new Counter("chat_closed_early");
const closeCode = new Counter("chat_close_code");
const holdMs = new Trend("chat_hold_ms", true);

/** 閉じた理由のコード(RFC 6455とCloudflareが返し得るもの)。サブ指標をsummaryに出すため閾値を置く */
const CLOSE_CODES = [1000, 1001, 1002, 1005, 1006, 1008, 1011, 1012];

/** 送るのを止めてから接続を閉じるまでの間(ミリ秒)。最後の送信の到着を待つ */
const CLOSE_GRACE_MS = 2_000;

export const options = {
	// chat_delivery_msの件数(相手から届いた発言の数)も結果の表に出す
	summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "count"],
	setupTimeout: `${chatSetupTimeoutSec(pairs, config.proposalWaitSec)}s`,
	scenarios: {
		chat_concurrent: {
			executor: "per-vu-iterations",
			vus: pairs * 2,
			iterations: 1,
			maxDuration: `${chatMaxDurationSec(holdSec)}s`,
		},
	},
	thresholds: {
		http_req_failed: ["rate<0.01"],
		// 全員が接続できること(01 §20に目標値は無く、到着の時間は参考値として報告書に載せる)
		chat_connect_failed: ["rate<0.01"],
		chat_pairs_unmatched: ["count<1"],
		// コードごとの件数をsummary-exportへ出すための閾値(常に真)
		...Object.fromEntries(
			CLOSE_CODES.map((c) => [`chat_close_code{code:${c}}`, ["count>=0"]]),
		),
	},
};

/**
 * 1組を成立させる。2人に同じLATCHの提案が届き、2人の参加でmatchedになればそのid、
 * そうでなければnull
 */
function matchPair(tokens, deadline) {
	const latchIds = tokens.map((token) => {
		const remainingSec = Math.max(0, (deadline - Date.now()) / 1_000);
		const found = waitForProposal(config.baseUrl, token, remainingSec);
		return found ? found.latch_id : null;
	});
	if (!latchIds[0] || latchIds[0] !== latchIds[1]) return null;
	let last = null;
	for (const token of tokens) {
		last = respondLatch(config.baseUrl, token, latchIds[0], "yes");
		if (!last) return null;
	}
	return last.status === "matched" ? latchIds[0] : null;
}

export function setup() {
	ensureTarget(config.baseUrl);
	// LOAD_SCALEが大きすぎて最後の組の開始が7日を超えるなら、登録の前に止める
	assertWithinStartLimit(Date.now(), pairs, CHAT_PAIR_SPACING_MS);
	const runId = runIdFromEnv();
	const groups = [];
	for (let k = 0; k < pairs; k += 1) {
		groups.push(
			pairSubjects(runId, "chat", k).map((s) => signIn(config.baseUrl, s)),
		);
	}
	const nowMs = Date.now();
	// 登録に時間が掛かり基準時刻が後ろへずれても収まることを、実際の基準で確かめ直す
	assertWithinStartLimit(nowMs, pairs, CHAT_PAIR_SPACING_MS);
	const baseMs = baseStartMs(nowMs);
	groups.forEach((tokens, k) => {
		const topic = TOPICS[k % TOPICS.length];
		const startMs = pairStartMs(baseMs, k, CHAT_PAIR_SPACING_MS);
		for (const token of tokens) {
			createOccasion(config.baseUrl, token, { topic, startMs });
		}
	});
	// 全組の提案待ちを同じ締め切りで行う(組ごとに上限を取り直すと準備が長くなる)
	const deadline = Date.now() + config.proposalWaitSec * 1_000;
	const matched = groups.map((tokens) => {
		const latchId = matchPair(tokens, deadline);
		if (!latchId) {
			unmatched.add(1);
			return null;
		}
		return { latchId, tokens };
	});
	return { runId, pairs: matched };
}

export default function (data) {
	const vu = exec.vu.idInTest;
	const pair = data.pairs[Math.floor((vu - 1) / 2)];
	// 成立できなかった組は接続しない(chat_pairs_unmatchedに出ている)
	if (!pair) return;
	const token = pair.tokens[(vu - 1) % 2];

	const ticket = wsTicket(config.baseUrl, token, pair.latchId);
	if (!ticket) {
		connectFailed.add(1);
		return;
	}

	// connecting→open→closed。openに至らずに終わったら接続の失敗として1回だけ数える
	let state = "connecting";
	let openedAt = 0;
	// 予定の保持時間が過ぎて自分から閉じ始めたか(閉じる前に閉じられたら途中で閉じた接続)
	let closingPlanned = false;
	let seq = 0;
	const timers = [];
	const stopTimers = () => {
		for (const t of timers.splice(0)) clearInterval(t);
	};
	const fail = () => {
		if (state !== "connecting") return;
		state = "closed";
		connectFailed.add(1);
	};

	const ws = new WebSocket(
		chatWsUrl(config.baseUrl, pair.latchId, ticket),
		null,
		{ headers: accessHeadersFromEnv() },
	);
	ws.onopen = () => {
		state = "open";
		openedAt = Date.now();
		connectFailed.add(0);
		timers.push(
			setInterval(() => {
				ws.send(
					JSON.stringify({
						type: "message",
						body: messageBody(Date.now()),
						client_id: clientId(vu, seq),
					}),
				);
				seq += 1;
				sent.add(1);
			}, SEND_INTERVAL_SEC * 1_000),
			setInterval(() => ws.send("ping"), PING_INTERVAL_SEC * 1_000),
		);
		setTimeout(() => {
			closingPlanned = true;
			stopTimers();
			setTimeout(() => ws.close(), CLOSE_GRACE_MS);
		}, holdSec * 1_000);
	};
	ws.onmessage = (event) => {
		const ms = deliveryMs(event.data, Date.now());
		if (ms !== null) delivery.add(ms);
	};
	ws.onerror = () => {
		// エラーの内容にはURL(チケットを含む)が入り得るため表示しない
		fail();
	};
	ws.onclose = (event) => {
		if (state === "open") {
			holdMs.add(Date.now() - openedAt);
			closeCode.add(1, { code: String(event?.code ?? "unknown") });
			if (!closingPlanned) closedEarly.add(1);
		}
		fail();
		state = "closed";
		stopTimers();
	};
}
