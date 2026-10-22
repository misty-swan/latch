/**
 * シナリオ(b)(d)の組の決め方の純関数(F8b設計 §3.3)。k6とvitestの両方から読むため、
 * k6やNodeに固有の部品をimportしない。
 * - parseMode: MODE(staggered=(b)・burst=(d))
 * - baseStartMs・pairStartMs: 組kの機会Intentの開始時刻(基準+k×3時間・2時間の幅)。
 *   組どうしは時間帯が重ならないため、Layer 1の時間の重なりの条件(time_no_overlap)で
 *   相手の組と外れる(stubのJevは常に高い値を返すため、ずらさないと組どうしが混ざる)
 * - pairSubjects: 組kの2人のsubject(`load-<runId>-b<n>`・(d)は`-d<n>`)
 * - maxDurationSec: k6のシナリオのmaxDuration(提案待ちを途中で切らない長さ)
 */

const MS_PER_HOUR = 3_600_000;
/** 基準時刻=実行時刻+24時間(1時間単位に切り上げ) */
const BASE_LEAD_MS = 24 * MS_PER_HOUR;
/** 組と組の開始時刻の間隔(意思の時間の幅2時間より長く、重ならない) */
export const PAIR_SPACING_MS = 3 * MS_PER_HOUR;
/** (b)の組ごとの投入の間隔(秒) */
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

/** 組k(0始まり)の開始時刻(ミリ秒) */
export function pairStartMs(baseMs, k) {
	return baseMs + k * PAIR_SPACING_MS;
}

/** 組k(0始まり)の2人のsubject。連番は1始まりで、組kは2k+1と2k+2 */
export function pairSubjects(runId, mode, k) {
	const tag = mode === "burst" ? "d" : "b";
	return [
		`load-${runId}-${tag}${2 * k + 1}`,
		`load-${runId}-${tag}${2 * k + 2}`,
	];
}

/**
 * シナリオのmaxDuration(秒)。投入までの待ち((b)は最後の組の(組数-1)×2秒・
 * (d)はBURST_LEAD_SEC)+提案待ちの上限+余裕
 */
export function maxDurationSec(mode, pairs, proposalWaitSec) {
	const launch = mode === "burst" ? BURST_LEAD_SEC : (pairs - 1) * STAGGER_SEC;
	return Math.ceil(launch + proposalWaitSec + SLACK_SEC);
}
