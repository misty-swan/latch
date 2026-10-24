/**
 * Jev実行器(設計書 §2.3・docs/06 §5〜§6)。
 * 1イベントあたりの呼び出し枠 K_j=8 の範囲で、第一候補を並列に呼び、
 * 切替対象の失敗はフォールバックへ回す。予算・circuit breakerで止まった分は保留として数える。
 */

import { LATCH } from "@latch/shared";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { type Clock, systemClock } from "../clock/clock";
import {
	isFallbackEligible,
	type JevAxes,
	type JevFn,
	type JevInput,
	type JevOutcome,
} from "../llm/types";
import { isBreakerOpen, recordJevOutcomes } from "./breaker";
import { reserveJevCall } from "./budget";

export interface JevTarget {
	/** match_candidates.id */
	key: string;
	input: JevInput;
}

export type JevHeldReason = "budget" | "breaker" | "failed" | "cap";

export interface JevRunResult {
	axes: Map<string, JevAxes>;
	/** 実呼び出し数(フォールバック含む・K_j以下) */
	calls: number;
	/** 保留の内訳。axesに入らなかった対象は必ずどれか1つに1回だけ数える */
	held: Record<JevHeldReason, number>;
	latencyMs: number;
}

/** 区間の所要時間の計測先(#36・試験と評価の記録用)。ラベルごとに全波の合計を呼び出し側が足す */
export type JevTimingLabel =
	| "jev_breaker"
	| "jev_reserve"
	| "jev_http"
	| "jev_record";

type QueueItem = { target: JevTarget; useFallback: boolean };

/**
 * JevFnを呼ぶ。例外は失敗種別otherとして扱う(予約消費後にrunJev全体を
 * rejectさせない・失敗は例外でなく型付きで返す規約の補強・docs/07 §5)
 */
const callSafely = async (fn: JevFn, input: JevInput): Promise<JevOutcome> => {
	try {
		return await fn(input);
	} catch {
		return { ok: false, kind: "other" };
	}
};

export const runJev = async (
	deps: {
		jev: { primary: JevFn; fallback: JevFn };
		db: DrizzleD1Database;
		kv: KVNamespace;
		clock: Clock;
		/** 区間ごとの実時間(ミリ秒)を受け取る。省略時は計測しない。振る舞いは変えない */
		onTiming?: (label: JevTimingLabel, ms: number) => void;
	},
	origin: { intentId: string; userId: string },
	targets: JevTarget[],
): Promise<JevRunResult> => {
	const { jev, db, kv, clock, onTiming } = deps;
	// 区間の計測は実時間(systemClock)。Clockは試験で止まっているため
	const timed = async <T>(
		label: JevTimingLabel,
		run: () => Promise<T>,
	): Promise<T> => {
		if (onTiming === undefined) {
			return run();
		}
		const t0 = systemClock.now().getTime();
		try {
			return await run();
		} finally {
			onTiming(label, systemClock.now().getTime() - t0);
		}
	};
	const startedAt = clock.now().getTime();
	const axes = new Map<string, JevAxes>();
	const held: Record<JevHeldReason, number> = {
		budget: 0,
		breaker: 0,
		failed: 0,
		cap: 0,
	};
	let calls = 0;
	let slots = LATCH.JEV_CALLS_PER_EVENT;
	// 待ち行列 = フォールバック待ち(先)+未実行の対象(後)
	let queue: QueueItem[] = targets.map((target) => ({
		target,
		useFallback: false,
	}));

	while (slots > 0 && queue.length > 0) {
		// 波の前にbreakerを確認し、開いていれば残り全件を保留する
		if (await timed("jev_breaker", () => isBreakerOpen(kv, clock.now()))) {
			held.breaker += queue.length;
			queue = [];
			break;
		}
		const n = Math.min(slots, queue.length);
		const wave = queue.slice(0, n);
		const rest = queue.slice(n);

		// 1件ずつ予算を確保し、最初に尽きた件以降は呼ばない
		const reserved: QueueItem[] = [];
		let budgetStopped = false;
		await timed("jev_reserve", async () => {
			for (const item of wave) {
				const r = await reserveJevCall(db, origin, clock.now());
				if (!r.ok) {
					budgetStopped = true;
					break;
				}
				reserved.push(item);
			}
		});

		// 外部呼び出し(並列)。外部送信の集計の書き込み(llm/mode.tsの包み)もここに含まれる
		const outcomes = await timed("jev_http", () =>
			Promise.all(
				reserved.map((item) =>
					callSafely(
						item.useFallback ? jev.fallback : jev.primary,
						item.target.input,
					),
				),
			),
		);
		calls += reserved.length;
		slots -= n;

		// breakerへの記録は1波につき1回にまとめる(KVの同一キー書き込みは1秒1回まで・docs/04 §4・docs/06 §5)
		await timed("jev_record", () =>
			recordJevOutcomes(
				kv,
				outcomes.map((o) => o.ok),
				clock.now(),
			),
		);
		const nextFallback: QueueItem[] = [];
		for (let i = 0; i < reserved.length; i++) {
			const item = reserved[i];
			const outcome = outcomes[i];
			if (outcome.ok) {
				axes.set(item.target.key, outcome.axes);
			} else if (!item.useFallback && isFallbackEligible(outcome.kind)) {
				nextFallback.push({ target: item.target, useFallback: true });
			} else {
				held.failed += 1;
			}
		}

		if (budgetStopped) {
			// 波の残り・フォールバック待ち・未実行はすべてbudget保留
			held.budget +=
				wave.length - reserved.length + nextFallback.length + rest.length;
			queue = [];
			break;
		}
		queue = [...nextFallback, ...rest];
	}

	// 枠が尽きて残った対象
	held.cap += queue.length;

	return {
		axes,
		calls,
		held,
		latencyMs: clock.now().getTime() - startedAt,
	};
};
