/**
 * プロダクト横断の定数。値の正本は docs/05 §2.2(カテゴリ)・§3.1(エラーコード)、
 * docs/04 §5・08 §8(上限値)。
 */

/** Intentのform。機会=occasion / つながり=connection */
export const INTENT_FORMS = ["connection", "occasion"] as const;
export type IntentForm = (typeof INTENT_FORMS)[number];

/** Intentのライフサイクル状態 */
export const INTENT_STATUSES = [
	"draft",
	"active",
	"paused",
	"matched",
	"expired",
	"cancelled",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** 低粒度タグ(カテゴリ)の初期セット。docs/05 §2.2・D-B-01 */
export const CATEGORIES = [
	"趣味・娯楽",
	"スポーツ・運動",
	"学び・語学",
	"創作・クリエイティブ",
	"テック・開発",
	"食・飲み",
	"旅行・アウトドア",
	"音楽・芸術",
	"読書・文化",
	"仕事・キャリア",
	"子育て・家庭",
	"健康・生活",
	"地域・コミュニティ",
	"ボランティア・社会",
	"その他",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** APIエラーコード。docs/05 §3.1 */
export const ERROR_CODES = [
	"UNAUTHORIZED",
	"TOKEN_EXPIRED",
	"FORBIDDEN",
	"NOT_FOUND",
	"VALIDATION_FAILED",
	"RATE_LIMITED",
	"ACTIVE_INTENT_LIMIT",
	"UNDER_AGE",
	"ALCOHOL_RESTRICTED",
	"FORM_MISMATCH",
	"PARSE_FAILED",
	"EMBEDDING_PENDING",
	"INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** マッチングイベント種別(Queue/DO間で発行される) */
export const MATCH_EVENT_TYPES = [
	"intent_created",
	"intent_updated",
	"intent_deleted",
	"intent_expired",
	"bucket_arrived",
	"embedding_completed",
] as const;
export type MatchEventType = (typeof MATCH_EVENT_TYPES)[number];

/** レート制限・予算カウンタのスコープ */
export const COUNTER_SCOPES = [
	"intent_daily",
	"intent_hourly",
	"jev_intent",
	"jev_user",
	"jev_global_daily",
	"jev_global_monthly",
] as const;
export type CounterScope = (typeof COUNTER_SCOPES)[number];

/** Latch(提案〜成立)の状態 */
export const LATCH_STATUSES = [
	"candidate",
	"proposed",
	"partial_accept",
	"matched",
	"rejected",
	"expired",
	"cancelled",
	"completed",
] as const;
export type LatchStatus = (typeof LATCH_STATUSES)[number];

/** アプリ内通知の種別 */
export const NOTIFICATION_TYPES = [
	"proposal",
	"matched",
	"closed",
	"system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** 提案への応答値。yes/no/defer(noはAPI専用・UIには置かない) */
export const LATCH_RESPONSE_VALUES = ["yes", "no", "defer"] as const;
export type LatchResponseValue = (typeof LATCH_RESPONSE_VALUES)[number];

/** 各種上限値。docs/04 §5・08 §8・05 §3.1 */
export const LIMITS = {
	REQUESTS_PER_MINUTE: 60,
	ACTIVE_INTENTS_PER_USER: 5,
	INTENT_CREATES_PER_DAY: 20,
	INTENT_UPDATES_PER_HOUR: 6,
	NOTIFICATIONS_PER_DAY: 6,
	JEV_PER_INTENT_PER_DAY: 40,
	JEV_PER_USER_PER_DAY: 120,
	JEV_GLOBAL_DAILY: 30_000,
	JEV_GLOBAL_MONTHLY: 600_000,
	TOPIC_MAX_LENGTH: 40,
	RAW_TEXT_MAX_LENGTH: 300,
	DISPLAY_NAME_MAX_LENGTH: 40,
	BIO_MAX_LENGTH: 200,
} as const;
