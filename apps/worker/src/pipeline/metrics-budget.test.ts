/**
 * 計測の書き込みの残り(metrics-budget.ts)の単体試験(#28)。
 * 残りは実行の入口ごとに作る別々の値で、互いに減らさないことも固定する
 */
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { type Stage2MetricsData, writeStage2Metrics } from "./metrics";
import { createMetricsBudget } from "./metrics-budget";

const data: Stage2MetricsData = {
	origin: "cron_other",
	joinKey: "k",
	retrievalCount: 0,
	l1Pass: 0,
	exclusions: {},
	l3Pass: 0,
	latencyMs: 0,
	jevCalls: 0,
	jevReused: 0,
	jevHeld: { budget: 0, breaker: 0, failed: 0, cap: 0 },
	jevLatencyMs: 0,
	l5OverThreshold: 0,
	proposed: 0,
	held: 0,
	l4SkippedParticipants: 0,
	groupPool: 0,
	groupSets: 0,
	groupJevCalls: 0,
	groupHeldSets: 0,
	groupOverThreshold: 0,
	groupProposed: 0,
	groupHeldProposals: 0,
	groupFailed: 0,
	retrievalMs: 0,
};

describe("createMetricsBudget", () => {
	it("残り3でtake(2)は真・take(2)は偽(残り1のまま)・take(1)は真", () => {
		const budget = createMetricsBudget(3);
		expect(budget.take(2)).toBe(true);
		expect(budget.take(2)).toBe(false);
		expect(budget.take(1)).toBe(true);
		expect(budget.take(1)).toBe(false);
	});

	it("2つの残りを交互に使っても互いに減らない", () => {
		const a = createMetricsBudget(2);
		const b = createMetricsBudget(2);
		expect(a.take(2)).toBe(true);
		expect(b.take(2)).toBe(true);
		expect(a.take(1)).toBe(false);
		expect(b.take(1)).toBe(false);
	});
});

describe("writeStage2Metrics", () => {
	it("残り1のときはwriteDataPointを1回も呼ばない(2件は両方書くか両方書かない)", () => {
		const writeDataPoint = vi.fn();
		const env = { PIPELINE_AX: { writeDataPoint } } as unknown as Env;
		writeStage2Metrics(env, data, createMetricsBudget(1));
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it("残り2のときは2件を書く", () => {
		const writeDataPoint = vi.fn();
		const env = { PIPELINE_AX: { writeDataPoint } } as unknown as Env;
		writeStage2Metrics(env, data, createMetricsBudget(2));
		expect(writeDataPoint).toHaveBeenCalledTimes(2);
	});
});
