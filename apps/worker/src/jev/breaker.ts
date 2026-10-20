/**
 * Jevのcircuit breaker(docs/06 §5)。KVに {failures, windowStartMs, openUntilMs} を持つ。
 * 5分窓で10連続失敗したら30分オープンし、その間はJevを呼ばない。
 * Workers KVは同一キーへの書き込みが1秒に1回までのため、状態の更新は1波の結果を
 * まとめて最大1回・状態が変わらないときは書かない(docs/04 §5・docs/06 §5)。
 * KVの読み書き失敗は評価を止めない(読めなければ閉とみなし・書けなければログを出して
 * 続行する。安全装置としての近似)。
 */

import { LATCH } from "@latch/shared";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";

export const BREAKER_KEY = "jev:breaker";

const logger = createLogger();

type BreakerState = {
	failures: number;
	windowStartMs: number;
	openUntilMs: number | null;
};

const INITIAL_STATE: BreakerState = {
	failures: 0,
	windowStartMs: 0,
	openUntilMs: null,
};

/** 状態を読む。KVの読み取りに失敗したら閉(初期状態)とみなす */
const readState = async (kv: KVNamespace): Promise<BreakerState> => {
	try {
		const raw = await kv.get<BreakerState>(BREAKER_KEY, "json");
		return raw ?? { ...INITIAL_STATE };
	} catch (error) {
		logger.warn("jev.breaker.kv_failed", { error_code: errorCodeOf(error) });
		return { ...INITIAL_STATE };
	}
};

/** オープン中(openUntilMs未満)ならtrue */
export const isBreakerOpen = async (
	kv: KVNamespace,
	now: Date,
): Promise<boolean> => {
	const state = await readState(kv);
	return state.openUntilMs !== null && now.getTime() < state.openUntilMs;
};

/** 1件の結果を状態へ反映する(純関数)。成功は失敗カウントを0へ戻し、openUntilMsは保持する */
const applyOutcome = (
	state: BreakerState,
	ok: boolean,
	nowMs: number,
): BreakerState => {
	if (ok) {
		return { ...state, failures: 0 };
	}
	const next = { ...state };
	if (nowMs - next.windowStartMs > LATCH.BREAKER_WINDOW_MS) {
		next.failures = 1;
		next.windowStartMs = nowMs;
	} else {
		next.failures += 1;
	}
	if (next.failures >= LATCH.BREAKER_FAILURES) {
		next.openUntilMs = nowMs + LATCH.BREAKER_OPEN_MS;
	}
	return next;
};

const sameState = (a: BreakerState, b: BreakerState): boolean =>
	a.failures === b.failures &&
	a.windowStartMs === b.windowStartMs &&
	a.openUntilMs === b.openUntilMs;

/**
 * Jev呼び出しの結果(1波分・呼び出し順)をまとめて記録する。読み取り1回・書き込みは
 * 状態が変わったときだけ1回。書き込みの失敗はログ(jev.breaker.kv_failed)を出して続行する
 */
export const recordJevOutcomes = async (
	kv: KVNamespace,
	results: readonly boolean[],
	now: Date,
): Promise<void> => {
	if (results.length === 0) return;
	const before = await readState(kv);
	const nowMs = now.getTime();
	const after = results.reduce((s, ok) => applyOutcome(s, ok, nowMs), before);
	if (sameState(before, after)) return;
	try {
		await kv.put(BREAKER_KEY, JSON.stringify(after));
	} catch (error) {
		logger.warn("jev.breaker.kv_failed", { error_code: errorCodeOf(error) });
	}
};
