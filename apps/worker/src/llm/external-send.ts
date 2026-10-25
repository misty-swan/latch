/**
 * 外部送信の日次集計(docs/08 §5・設計書 §8.1)。LLMの外部API(Anthropic・TypeSafe)へ
 * 送るたびに usage_counters(scope=external_send)へ「宛先:用途」×JST日付で1加算する。
 * 成否を問わず送った回数を数える(フォールバックの呼び出しも1回ずつ)。
 * 数えられなくても本処理を止めない: 失敗はログだけで例外を外へ出さない。
 */

import type { Clock } from "../clock/clock";
import { jstDayKey } from "../clock/clock";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";

const logger = createLogger();

export type ExternalSendKey =
	| "anthropic:parser"
	| "anthropic:jev"
	| "typesafe:jev";

/** 一時的なD1の失敗だけをやり直す。待ちは50ms・100msの最大2回(合計150ms・#42) */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	"D1_OVERLOADED",
	"D1_BUSY",
	"D1_RESET",
]);
const RETRY_WAITS_MS = [50, 100] as const;

export const recordExternalSend = async (
	db: D1Database,
	clock: Clock,
	key: ExternalSendKey,
): Promise<void> => {
	const period = jstDayKey(clock.now());
	for (let attempt = 0; ; attempt += 1) {
		try {
			await db
				.prepare(
					"INSERT INTO usage_counters (scope, key, period, count) VALUES ('external_send', ?, ?, 1) " +
						"ON CONFLICT(scope, key, period) DO UPDATE SET count = count + 1",
				)
				.bind(key, period)
				.run();
			return;
		} catch (error) {
			const code = errorCodeOf(error, "D1_ERROR");
			const wait = RETRY_WAITS_MS[attempt];
			if (wait === undefined || !RETRYABLE_CODES.has(code)) {
				logger.warn("external_send.record.failed", { error_code: code });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
};
