/**
 * k6のシナリオの共通部(F8b設計 §3)。k6のhttpで動く(Nodeからは読まない)。
 * - loadConfig: 環境変数(LATCH_LOAD_BASE_URL・LOAD_SCALE・RUN_ID・PROPOSAL_WAIT_SEC)
 * - ensureTarget: 宛先の確認(dev専用サインインが200でなければ中止。prodは404)
 * - signIn: テスト用サインイン→登録(subject=`load-<runId>-<連番>`)
 * - parseIntent・saveIntent・createOccasion: 意思の読み解き・保存
 * - waitForProposal: 提案のアプリ内通知が届くまで待つ
 * 各リクエストにはk6のタグ`name`を付け、閾値と集計をこの名前で絞る。
 * 宛先のURLは表示しない(stagingのURLはログに残さない・設計 §2.1)。
 */

import { check, sleep } from "k6";
import http from "k6/http";
import { checkTarget, parseScale, resolveRunId } from "./target.mjs";

/** 機会Intentの地域(worker E2E apps/worker/e2e/latches.spec.tsのsite(0)と同じ値) */
export const LOAD_GEO = { center: { lat: 33, lng: 131.5 }, radius_m: 1_000 };

const MS_PER_HOUR = 3_600_000;
/** 提案待ちの既定の上限(秒)。staging不具合#7の間はバックフィル経由のため延ばして使う */
const DEFAULT_PROPOSAL_WAIT_SEC = 60;

/**
 * 環境変数を読む。runIdはVUごとに時刻がずれないよう、setupで1回だけ決めて
 * 本体へ渡すこと(init文脈で決めるとVUごとに分の境目をまたぎ得る)
 */
export function loadConfig() {
	const baseUrl = (__ENV.LATCH_LOAD_BASE_URL || "").replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error("LATCH_LOAD_BASE_URLが未設定です");
	}
	const waitSec =
		__ENV.PROPOSAL_WAIT_SEC === undefined || __ENV.PROPOSAL_WAIT_SEC === ""
			? DEFAULT_PROPOSAL_WAIT_SEC
			: Number(__ENV.PROPOSAL_WAIT_SEC);
	if (!Number.isFinite(waitSec) || waitSec <= 0) {
		throw new Error("PROPOSAL_WAIT_SECは正の数(秒)で指定してください");
	}
	return {
		baseUrl,
		scale: parseScale(__ENV.LOAD_SCALE),
		proposalWaitSec: waitSec,
	};
}

/** 実行の印(-e RUN_IDが無ければ現在時刻のUTCのYYYYMMDDHHmm)。setupで呼ぶ */
export function runIdFromEnv() {
	return resolveRunId(__ENV.RUN_ID);
}

const json = (body) => JSON.stringify(body);

const headers = (token) => {
	const h = { "content-type": "application/json" };
	if (token) h.authorization = `Bearer ${token}`;
	return h;
};

/** 期待の状態コードでなければ例外にする(setupの準備で使う。URLは出さない) */
function expectStatus(res, expected, label) {
	if (res.status !== expected) {
		throw new Error(`${label} が${res.status}(期待${expected})`);
	}
	return res.json();
}

/** dev専用サインインのIdPトークンを得る */
function devIdpToken(baseUrl, subject) {
	return http.post(`${baseUrl}/v1/dev/idp-token`, json({ subject }), {
		headers: headers(),
		tags: { name: "dev_idp_token" },
	});
}

/** 宛先がstaging(dev専用サインインが使える)であることを確かめる。違えば中止 */
export function ensureTarget(baseUrl) {
	checkTarget(devIdpToken(baseUrl, "load-target-check").status);
}

/**
 * テスト用サインイン→登録の順で、登録後のaccess_tokenを返す。
 * 同じsubjectで2回目に呼んだときは(-e RUN_IDの使い回し等)登録を飛ばす
 */
export function signIn(baseUrl, subject) {
	const idp = expectStatus(
		devIdpToken(baseUrl, subject),
		200,
		"POST /v1/dev/idp-token",
	);
	const auth = expectStatus(
		http.post(
			`${baseUrl}/v1/auth/token`,
			json({ provider: "google", idp_token: idp.idp_token }),
			{ headers: headers(), tags: { name: "auth_token" } },
		),
		200,
		"POST /v1/auth/token",
	);
	if (!auth.registration_required) {
		return auth.access_token;
	}
	const registered = expectStatus(
		http.post(
			`${baseUrl}/v1/users`,
			json({ display_name: "負荷試験", birth_date: "2000-01-01", bio: "" }),
			{ headers: headers(auth.access_token), tags: { name: "register" } },
		),
		201,
		"POST /v1/users",
	);
	return registered.access_token;
}

/** 読み解き(POST /v1/intents/parse)。応答(k6のResponse)をそのまま返す */
export function parseIntent(baseUrl, token, rawText) {
	return http.post(`${baseUrl}/v1/intents/parse`, json({ raw_text: rawText }), {
		headers: headers(token),
		tags: { name: "parse" },
	});
}

/** 保存(POST /v1/intents)。応答(k6のResponse)をそのまま返す */
export function saveIntent(baseUrl, token, body) {
	return http.post(`${baseUrl}/v1/intents`, json(body), {
		headers: headers(token),
		tags: { name: "intent_save" },
	});
}

/**
 * 機会Intentをactiveで保存してidを返す(time=startMs〜+2時間・geo=LOAD_GEO)。
 * 失敗したら例外(呼び出し側の準備を止める)
 */
export function createOccasion(baseUrl, token, { topic, startMs }) {
	const res = saveIntent(baseUrl, token, {
		raw_text: topic,
		form: "occasion",
		topic,
		time: {
			start: new Date(startMs).toISOString(),
			end: new Date(startMs + 2 * MS_PER_HOUR).toISOString(),
		},
		geo: LOAD_GEO,
		status: "active",
	});
	check(res, { 機会Intentの保存が201: (r) => r.status === 201 });
	return expectStatus(res, 201, "POST /v1/intents(機会)").id;
}

/**
 * 提案のアプリ内通知(type=proposal)が届くまで1秒間隔で待つ。
 * 届いたらその通知を、maxWaitSec秒を過ぎたらnullを返す
 */
export function waitForProposal(baseUrl, token, maxWaitSec) {
	const deadline = Date.now() + maxWaitSec * 1_000;
	for (;;) {
		const res = http.get(`${baseUrl}/v1/notifications`, {
			headers: headers(token),
			tags: { name: "notifications" },
		});
		if (res.status === 200) {
			const found = res.json().items.find((n) => n.type === "proposal");
			if (found) return found;
		}
		if (Date.now() >= deadline) return null;
		sleep(1);
	}
}
