/**
 * 構造化ログ・許可リスト(docs/08 §6)。
 * ログに出力できるフィールドは許可リスト(LOG_FIELD_ALLOWLIST)の項目のみ。呼び出し側が余分なキーを渡しても
 * Serializer段(JSON化の直前)の実行時フィルタで黙って破棄する。
 * raw_text・座標・NG条件・表示名・user_idは不許可(08 §6。user_idを含む個人を識別
 * できる値はAnalytics Engine・Workers Logsにも書かない)。
 */

export const LOG_FIELD_ALLOWLIST = [
	"intent_id",
	"latch_id",
	"status",
	"version",
	"error_code",
	"layer",
	"count",
	"latency",
	// Web Pushの結果記録(F7b設計 §5.8)。endpoint・鍵・本文は許可しない
	"notification_id",
	"http_status",
	"push_result",
	// 評価のLayer 2 Candidate Retrievalの照会の件数と控えから補った件数(#47・設計 2026-10-25 §1.5)
	"retrieval_count",
	"supplement_count",
	// チャット接続の切断の記録(#46)。閉じた理由のコードと接続を受け入れてからの保持時間(ミリ秒)
	"close_code",
	"hold_ms",
] as const;

export type LogField = (typeof LOG_FIELD_ALLOWLIST)[number];

export type LogFields = Partial<Record<LogField, string | number>>;

export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

/** 許可判定の突合先。実行時フィルタでのみ参照する */
const allowedFieldSet: ReadonlySet<string> = new Set(LOG_FIELD_ALLOWLIST);

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * 許可フィールドだけを残す実行時フィルタ(08 §6: Serializer段で強制)。
 * 許可リスト外のキーは警告・例外なしで黙って破棄する。
 * 値が文字列でも数値でもない許可フィールド(undefined・null・ネストした
 * オブジェクト・boolean等)はキーごと落とす。user_idが値の奥に隠れていても
 * 出力行に現れない。
 */
const serializeFields = (
	fields: LogFields | undefined,
): Record<string, string | number> => {
	const allowed: Record<string, string | number> = {};
	if (fields === undefined || fields === null) {
		return allowed;
	}
	for (const [key, value] of Object.entries(fields)) {
		if (!allowedFieldSet.has(key)) {
			continue;
		}
		if (typeof value !== "string" && typeof value !== "number") {
			continue;
		}
		allowed[key] = value;
	}
	return allowed;
};

const createLevelMethod =
	(level: LogLevel, sink: (line: string) => void) =>
	(event: string, fields?: LogFields): void => {
		sink(JSON.stringify({ level, event, ...serializeFields(fields) }));
	};

/** 構造化ロガーを生成する。sinkの既定は呼び出し時点のconsole.log(1呼び出しにつき1行出力・試験のspyが効く) */
export const createLogger = (
	sink: (line: string) => void = (line) => console.log(line),
): Logger => ({
	debug: createLevelMethod("debug", sink),
	info: createLevelMethod("info", sink),
	warn: createLevelMethod("warn", sink),
	error: createLevelMethod("error", sink),
});
