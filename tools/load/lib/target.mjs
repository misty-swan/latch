/**
 * 負荷試験の共有の純関数(F8b設計 §3)。k6のスクリプトとNode(cleanup.mjs・vitest)の
 * 両方から読むため、k6やNodeに固有の部品をimportしない。
 * - checkTarget: 宛先の確認(dev専用サインインが200でなければ中止。prodは404)
 * - runIdNow・resolveRunId: 実行の印(UTCのYYYYMMDDHHmm。集計のSQLが12桁の数字を前提にする)
 * - parseScale・scaled: LOAD_SCALE(rate・人数・時間に掛ける倍率)
 * - bodyFromParse: 読み解き(parse)の応答→保存(POST /v1/intents)の本文。
 *   読み解き確認の[預ける](apps/web/src/intents/submit.tsのconfirmValuesFromParse→
 *   buildCreateIntentRequest)と同じ組み立て方にする。k6は@latch/sharedを読めないため、
 *   使う定数(packages/shared/src/constants.ts)をここに写す
 */

/** 人数の範囲(PARTICIPANTS_MIN・PARTICIPANTS_MAX・docs/05 §2.2) */
const PARTICIPANTS_MIN = 2;
const PARTICIPANTS_MAX = 4;
/** 予算の上限(BUDGET_MAX) */
const BUDGET_MAX = 9_999_999;
/** 機会の既定期限=開始+3時間(OCCASION_DEFAULT_TTL_HOURS) */
const OCCASION_DEFAULT_TTL_MS = 3 * 3_600_000;
/** つながりの期限の既定(EXPIRY_CHOICES_DAYSの2番目=読み解き確認の初期値) */
const CONNECTION_DEFAULT_EXPIRES_IN_DAYS = 30;

/** POST /v1/dev/idp-tokenの状態コードで宛先を確かめる(200以外は中止) */
export function checkTarget(status) {
	if (status !== 200) {
		throw new Error("宛先がstagingではありません(dev専用サインインが使えない)");
	}
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 実行の印(UTCのYYYYMMDDHHmm) */
export function runIdNow(now = new Date()) {
	return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
}

/** RUN_IDの指定を使い、無ければ現在時刻から作る。12桁の数字でなければ例外 */
export function resolveRunId(value, now = new Date()) {
	const runId = value === undefined || value === "" ? runIdNow(now) : value;
	if (!/^\d{12}$/.test(runId)) {
		throw new Error("RUN_IDは12桁の数字(UTCのYYYYMMDDHHmm)で指定してください");
	}
	return runId;
}

/** LOAD_SCALEを読む(既定1・正の数のみ) */
export function parseScale(value) {
	if (value === undefined || value === "") return 1;
	const scale = Number(value);
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new Error("LOAD_SCALEは正の数で指定してください");
	}
	return scale;
}

/** 基準値に倍率を掛けて四捨五入する(1を下回らない) */
export function scaled(base, scale) {
	return Math.max(1, Math.round(base * scale));
}

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * parseの応答→POST /v1/intentsの本文(status=active)。
 * 機会で日時が無いものは保存できないためnullを返す(読み解き確認では日時の入力を促す)
 */
export function bodyFromParse(parse, rawText) {
	const isOccasion = parse.form === "occasion";
	const startIso =
		isOccasion && parse.time !== null
			? new Date(parse.time.start).toISOString()
			: null;
	if (isOccasion && startIso === null) return null;

	const min = clamp(parse.participants.min, PARTICIPANTS_MIN, PARTICIPANTS_MAX);
	const max = clamp(parse.participants.max, min, PARTICIPANTS_MAX);
	let budget = null;
	if (isOccasion && parse.budget !== null) {
		const bMin = clamp(parse.budget.min, 0, BUDGET_MAX);
		const bMax = clamp(parse.budget.max, 0, BUDGET_MAX);
		budget = { min: Math.min(bMin, bMax), max: bMax, currency: "JPY" };
	}

	const body = {
		form: parse.form,
		topic: parse.topic.trim(),
		category: parse.category,
		time: startIso === null ? null : { start: startIso, end: null },
		geo: null,
		participants: { min, max, includes_owner: true },
		budget,
		hard_constraints: [],
		soft_constraints: [],
		negative_constraints: [],
		notification_level: "proposals_only",
		alcohol_involved: isOccasion ? parse.alcohol_involved : false,
		raw_text: rawText,
		status: "active",
	};
	if (isOccasion) {
		body.expires_at = new Date(
			new Date(startIso).getTime() + OCCASION_DEFAULT_TTL_MS,
		).toISOString();
	} else {
		body.expires_in_days = CONNECTION_DEFAULT_EXPIRES_IN_DAYS;
	}
	return body;
}
