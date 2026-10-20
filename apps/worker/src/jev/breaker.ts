/**
 * Jevのcircuit breaker(docs/06 §5)。KVに {failures, windowStartMs, openUntilMs} を持つ。
 * 5分窓で10連続失敗したら30分オープンし、その間はJevを呼ばない。
 */

import { LATCH } from "@latch/shared";

export const BREAKER_KEY = "jev:breaker";

type BreakerState = {
	failures: number;
	windowStartMs: number;
	openUntilMs: number | null;
};

const readState = async (kv: KVNamespace): Promise<BreakerState> => {
	const raw = await kv.get<BreakerState>(BREAKER_KEY, "json");
	return raw ?? { failures: 0, windowStartMs: 0, openUntilMs: null };
};

/** オープン中(openUntilMs未満)ならtrue */
export const isBreakerOpen = async (
	kv: KVNamespace,
	now: Date,
): Promise<boolean> => {
	const state = await readState(kv);
	return state.openUntilMs !== null && now.getTime() < state.openUntilMs;
};

/** Jev呼び出しの結果を記録する。成功は失敗カウントを0へ戻し、openUntilMsは保持する */
export const recordJevOutcome = async (
	kv: KVNamespace,
	ok: boolean,
	now: Date,
): Promise<void> => {
	const state = await readState(kv);
	const nowMs = now.getTime();
	if (ok) {
		state.failures = 0;
	} else {
		if (nowMs - state.windowStartMs > LATCH.BREAKER_WINDOW_MS) {
			state.failures = 1;
			state.windowStartMs = nowMs;
		} else {
			state.failures += 1;
		}
		if (state.failures >= LATCH.BREAKER_FAILURES) {
			state.openUntilMs = nowMs + LATCH.BREAKER_OPEN_MS;
		}
	}
	await kv.put(BREAKER_KEY, JSON.stringify(state));
};
