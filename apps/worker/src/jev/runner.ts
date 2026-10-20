/**
 * Jev実行器(設計書 §2.3・docs/06 §5〜§6)。
 * 1イベントあたりの呼び出し枠 K_j=8 の範囲で、第一候補を並列に呼び、
 * 切替対象の失敗はフォールバックへ回す。予算・circuit breakerで止まった分は保留として数える。
 */

import { LATCH } from "@latch/shared";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import {
	isFallbackEligible,
	type JevAxes,
	type JevFn,
	type JevInput,
} from "../llm/types";
import { isBreakerOpen, recordJevOutcome } from "./breaker";
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

type QueueItem = { target: JevTarget; useFallback: boolean };

export const runJev = async (
	deps: {
		jev: { primary: JevFn; fallback: JevFn };
		db: DrizzleD1Database;
		kv: KVNamespace;
		clock: Clock;
	},
	origin: { intentId: string; userId: string },
	targets: JevTarget[],
): Promise<JevRunResult> => {
	const { jev, db, kv, clock } = deps;
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
		if (await isBreakerOpen(kv, clock.now())) {
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
		for (const item of wave) {
			const r = await reserveJevCall(db, origin, clock.now());
			if (!r.ok) {
				budgetStopped = true;
				break;
			}
			reserved.push(item);
		}

		const outcomes = await Promise.all(
			reserved.map((item) =>
				(item.useFallback ? jev.fallback : jev.primary)(item.target.input),
			),
		);
		calls += reserved.length;
		slots -= n;

		// KVの読み書き競合を避けるため、結果の記録は順に行う
		const nextFallback: QueueItem[] = [];
		for (let i = 0; i < reserved.length; i++) {
			const item = reserved[i];
			const outcome = outcomes[i];
			await recordJevOutcome(kv, outcome.ok, clock.now());
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
