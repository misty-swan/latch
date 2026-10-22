/**
 * シナリオ(c) チャット同時接続の純関数(F8b設計 §3.3)。k6とvitestの両方から読むため、
 * k6やNodeに固有の部品をimportしない。
 * - chatPlan: 組数(50×倍率)と接続を保つ秒数(5分×倍率)
 * - chatSetupTimeoutSec・chatMaxDurationSec: k6のsetupTimeoutとmaxDuration
 * - chatWsUrl: 宛先のURL(https)→チャットのWebSocketのURL(wss)。URLは表示しない
 * - messageBody・clientId: 送るフレームの本文(`t=<送った時刻のミリ秒>`)とclient_id
 * - deliveryMs: 受け取ったフレームが相手の発言なら、送信から到着までのミリ秒
 */

import { scaled } from "./target.mjs";

/** 組数の基準(50組=100人) */
export const CHAT_PAIRS = 50;
/** 接続を保つ秒数の基準(5分) */
export const CHAT_HOLD_SEC = 300;
/** 送る間隔(秒) */
export const SEND_INTERVAL_SEC = 5;
/** pingの間隔(秒。画面のapps/web/src/chat/socket.tsと同じ25秒) */
export const PING_INTERVAL_SEC = 25;
/** setupの余裕(秒)の固定分。提案待ちの上限に足す */
const SETUP_SLACK_SEC = 300;
/** setupの余裕(秒)の組あたりの分(2人のサインイン・意思の保存・参加の回答) */
const SETUP_PER_PAIR_SEC = 6;
/** 本体の余裕(秒)。チケットの発行と接続の分 */
const RUN_SLACK_SEC = 60;

/** 組数と接続を保つ秒数(どちらも倍率を掛けて四捨五入・最低1) */
export function chatPlan(scale) {
	return {
		pairs: scaled(CHAT_PAIRS, scale),
		holdSec: scaled(CHAT_HOLD_SEC, scale),
	};
}

/**
 * setupTimeout(秒)。staging不具合#7の間は提案が毎分の定期処理経由で5〜10分後に届くため、
 * 固定の値にせず提案待ちの上限から決める
 */
export function chatSetupTimeoutSec(pairs, proposalWaitSec) {
	return Math.ceil(
		proposalWaitSec + SETUP_SLACK_SEC + pairs * SETUP_PER_PAIR_SEC,
	);
}

/** 本体のmaxDuration(秒)。接続を保つ秒数+余裕 */
export function chatMaxDurationSec(holdSec) {
	return holdSec + RUN_SLACK_SEC;
}

/** チャットのWebSocketのURL(http→ws・https→wss) */
export function chatWsUrl(baseUrl, latchId, ticket) {
	const wsBase = baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
	return `${wsBase}/v1/latches/${latchId}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** 送る本文(送った時刻) */
export function messageBody(nowMs) {
	return `t=${nowMs}`;
}

/** 送るclient_id(`<VUの番号>-<連番>`) */
export function clientId(vu, seq) {
	return `${vu}-${seq}`;
}

/**
 * 受け取ったフレーム(JSON文字列)が相手の発言なら、送信から到着までのミリ秒を返す。
 * それ以外(自分の送信の折り返し・error・closed・pong・読めない本文)はnull。
 * 折り返しの見分け: サーバーはclient_idを送った本人にだけ返し、相手にはnullで配る
 * (apps/worker/src/chat/messages.tsのtoMessageDto)
 */
export function deliveryMs(raw, nowMs) {
	let frame;
	try {
		frame = JSON.parse(raw);
	} catch {
		return null;
	}
	if (frame === null || typeof frame !== "object") return null;
	if (frame.type !== "message" || frame.client_id !== null) return null;
	const m = /^t=(\d+)$/.exec(String(frame.body));
	if (!m) return null;
	return nowMs - Number(m[1]);
}
