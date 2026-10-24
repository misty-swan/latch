/**
 * 1回の実行の計測の書き込みの残り(#28)。Analytics Engineの書き込みは1回の呼び出しで
 * 250件までのため、PIPELINE.METRICS_WRITES_PER_INVOCATIONを上限に数える。
 * 残りはモジュールの変数にしない。同じisolateが同時に扱う別の実行と共有しないよう、
 * 実行の入口(キューのバッチごと・scheduledの1回ごと)で作って渡す
 */
import { PIPELINE } from "@latch/shared";
import { createLogger } from "../logging/logger";

const logger = createLogger();

export interface MetricsBudget {
	/** 残りがn以上なら減らして真。足りなければ減らさず偽(最初の偽のときだけwarnする) */
	take(n: number): boolean;
}

export const createMetricsBudget = (
	limit: number = PIPELINE.METRICS_WRITES_PER_INVOCATION,
): MetricsBudget => {
	let remaining = limit;
	let warned = false;
	return {
		take(n) {
			if (remaining >= n) {
				remaining -= n;
				return true;
			}
			if (!warned) {
				warned = true;
				logger.warn("pipeline.metrics.skipped", { count: remaining });
			}
			return false;
		},
	};
};
