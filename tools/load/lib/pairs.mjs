/**
 * シナリオ(b)(c)(d)の組の決め方の純関数(F8b設計 §3.3)。k6とvitestの両方から読むため、
 * k6やNodeに固有の部品をimportしない。
 * - parseMode: MODE(staggered=(b)・burst=(d))
 * - baseStartMs・pairStartMs: 組kの機会Intentの開始時刻(基準+k×3時間・2時間の幅)。
 *   組どうしは時間帯が重ならないため、Layer 1の時間の重なりの条件(time_no_overlap)で
 *   相手の組と外れる(stubのJevは常に高い値を返すため、ずらさないと組どうしが混ざる)
 *   (c)は組が50組と多く、3時間の間隔では最後の組が機会の開始の上限(7日以内)を超えるため、
 *   間隔CHAT_PAIR_SPACING_MS(2時間)を渡す(隣の組との重なりは0分で、下限15分を下回り外れる)
 * - pairSubjects: 組kの2人のsubject(`load-<runId>-b<n>`・(c)は`-c<n>`・(d)は`-d<n>`)
 * - maxDurationSec: k6のシナリオのmaxDuration(提案待ちを途中で切らない長さ)
 * - maxPairsWithinStartLimit・assertWithinStartLimit: 最後の組の開始が機会の開始の上限
 *   (保存の時点から7日以内・docs/05 §2.2)に収まるかの確かめ(LOAD_SCALEの上げすぎを準備で止める)
 */

const MS_PER_HOUR = 3_600_000;
/** 基準時刻=実行時刻+24時間(1時間単位に切り上げ) */
const BASE_LEAD_MS = 24 * MS_PER_HOUR;
/** 組と組の開始時刻の間隔(意思の時間の幅2時間より長く、重ならない) */
export const PAIR_SPACING_MS = 3 * MS_PER_HOUR;
/**
 * (c)の組と組の開始時刻の間隔。意思の幅2時間と同じで、隣の組とは端が接するだけ
 * (重なり0分<Layer 1の下限15分)。50組でも最後の開始が実行時刻+7日以内に収まる
 */
export const CHAT_PAIR_SPACING_MS = 2 * MS_PER_HOUR;
/** 組の種類ごとのsubjectの印(staggered=(b)・chat=(c)・burst=(d)) */
const SUBJECT_TAGS = { staggered: "b", chat: "c", burst: "d" };
/** (b)の組ごとの投入の間隔(秒)。組の中は片方が先に保存し、反映を確かめてからもう片方が保存する */
export const STAGGER_SEC = 2;
/** (d)でsetupの終わりから一斉投入までに置く間(秒)。全VUが起動してsleepに入る余裕 */
export const BURST_LEAD_SEC = 10;
/** 投入と提案待ちの後に残す余裕(秒)。HTTPの所要時間などの分 */
const SLACK_SEC = 120;

/** MODEを読む(既定staggered)。staggered・burst以外は例外 */
export function parseMode(value) {
	const mode = value === undefined || value === "" ? "staggered" : value;
	if (mode !== "staggered" && mode !== "burst") {
		throw new Error("MODEはstaggered((b))かburst((d))で指定してください");
	}
	return mode;
}

/** 基準時刻(ミリ秒)。実行時刻+24時間を1時間単位に切り上げる */
export function baseStartMs(nowMs) {
	return Math.ceil((nowMs + BASE_LEAD_MS) / MS_PER_HOUR) * MS_PER_HOUR;
}

/** 組k(0始まり)の開始時刻(ミリ秒)。間隔の既定はPAIR_SPACING_MS((b)(d)) */
export function pairStartMs(baseMs, k, spacingMs = PAIR_SPACING_MS) {
	return baseMs + k * spacingMs;
}

/**
 * 組k(0始まり)の2人のsubject。連番は1始まりで、組kは2k+1と2k+2。
 * kindはstaggered((b))・chat((c))・burst((d))。それ以外は例外
 */
export function pairSubjects(runId, kind, k) {
	const tag = SUBJECT_TAGS[kind];
	if (!tag) {
		throw new Error(`組の種類が不正です(${kind})`);
	}
	return [
		`load-${runId}-${tag}${2 * k + 1}`,
		`load-${runId}-${tag}${2 * k + 2}`,
	];
}

/**
 * シナリオのmaxDuration(秒)。投入までの待ち((b)は最後の組の(組数-1)×2秒・
 * (d)はBURST_LEAD_SEC)+(b)の先に保存した側の反映待ちの上限(提案待ちと同じ長さ)+提案待ちの上限+余裕
 */
export function maxDurationSec(mode, pairs, proposalWaitSec) {
	const launch = mode === "burst" ? BURST_LEAD_SEC : (pairs - 1) * STAGGER_SEC;
	const reflectionWait = mode === "burst" ? 0 : proposalWaitSec;
	return Math.ceil(launch + reflectionWait + proposalWaitSec + SLACK_SEC);
}

/** 機会Intentの開始の上限(保存の時点+7日以内・docs/05 §2.2・OCCASION_STARTS_AT_MAX_DAYS_AHEAD) */
export const OCCASION_START_LIMIT_MS = 7 * 24 * MS_PER_HOUR;

/**
 * 実行時刻によらず最後の組の開始が上限に収まる組数の最大。基準時刻は実行時刻+24時間を
 * 切り上げるため、最も遅いときで実行時刻+25時間になる。(b)(d)(間隔3時間)は48組
 * (LOAD_SCALE 1.6まで)、(c)(間隔2時間)は72組(LOAD_SCALE 1.44まで)
 */
export function maxPairsWithinStartLimit(spacingMs = PAIR_SPACING_MS) {
	const worstLeadMs = BASE_LEAD_MS + MS_PER_HOUR;
	return Math.floor((OCCASION_START_LIMIT_MS - worstLeadMs) / spacingMs) + 1;
}

/**
 * 最後の組(pairs−1)の開始が実行時刻nowMsから7日以内に収まらなければ例外にする。
 * 保存はnowMsより後に行うため、ここで収まれば保存の時点でも収まる
 */
export function assertWithinStartLimit(
	nowMs,
	pairs,
	spacingMs = PAIR_SPACING_MS,
) {
	const lastStartMs = pairStartMs(baseStartMs(nowMs), pairs - 1, spacingMs);
	if (lastStartMs - nowMs > OCCASION_START_LIMIT_MS) {
		throw new Error(
			`組数${pairs}では最後の組の開始が機会の開始の上限(7日以内)を超えます。LOAD_SCALEを下げてください(この間隔での組数の上限は${maxPairsWithinStartLimit(spacingMs)}組)`,
		);
	}
}
