/**
 * 外部送信の日次集計(docs/08 §5・設計書 §8.1)。LLMの外部API(Anthropic・TypeSafe)へ
 * 送るたびに usage_counters(scope=external_send)へ「宛先:用途」×JST日付で1加算する。
 * 成否を問わず送った回数を数える(フォールバックの呼び出しも1回ずつ)。
 * 数えられなくても本処理を止めない: 失敗はログだけで例外を外へ出さない。
 */

import type { Clock } from "../clock/clock";
import { jstDayKey } from "../clock/clock";
import { createLogger } from "../logging/logger";

const logger = createLogger();

export type ExternalSendKey =
	| "anthropic:parser"
	| "anthropic:jev"
	| "typesafe:jev";

export const recordExternalSend = async (
	db: D1Database,
	clock: Clock,
	key: ExternalSendKey,
): Promise<void> => {
	try {
		await db
			.prepare(
				"INSERT INTO usage_counters (scope, key, period, count) VALUES ('external_send', ?, ?, 1) " +
					"ON CONFLICT(scope, key, period) DO UPDATE SET count = count + 1",
			)
			.bind(key, jstDayKey(clock.now()))
			.run();
	} catch {
		logger.warn("external_send.record.failed", { error_code: "D1_ERROR" });
	}
};
