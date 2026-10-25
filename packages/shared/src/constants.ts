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

/** 認証プロバイダ。docs/05 §2.2(users.auth_provider)・04 §5 */
export const AUTH_PROVIDERS = ["google", "apple"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

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
	"UPGRADE_REQUIRED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** エラーコード対応のHTTPステータス。docs/05 §3.1 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
	UNAUTHORIZED: 401,
	TOKEN_EXPIRED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	VALIDATION_FAILED: 400,
	RATE_LIMITED: 429,
	ACTIVE_INTENT_LIMIT: 422,
	UNDER_AGE: 422,
	ALCOHOL_RESTRICTED: 422,
	FORM_MISMATCH: 400,
	PARSE_FAILED: 422,
	EMBEDDING_PENDING: 409,
	INTERNAL: 500,
	UPGRADE_REQUIRED: 426,
};

/** マッチングイベント種別(Queue/DO間で発行される) */
export const MATCH_EVENT_TYPES = [
	"intent_created",
	"intent_updated",
	"intent_deleted",
	"intent_expired",
	"bucket_arrived",
	"embedding_completed",
	"vector_reflection",
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
	// 外部送信の日次集計(08 §5・key=宛先:用途・period=JST日付)
	"external_send",
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
	"intent_expired",
	"system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** アプリ内通知のWeb Push送出状態(F7b設計 §2)。対象はproposal・matchedだけがpendingで始まる */
export const PUSH_STATES = [
	"none",
	"pending",
	"sent",
	"muted",
	"no_subscription",
	"failed",
] as const;
export type PushState = (typeof PUSH_STATES)[number];

/** Web Pushと通知一覧の上限値(F7b設計 §2) */
export const PUSH_LIMITS = {
	SUBSCRIPTIONS_PER_USER: 10,
	ENDPOINT_MAX_LENGTH: 1024,
	NOTIFICATIONS_PAGE_SIZE: 20,
} as const;

/** 提案への応答値。yes/no/defer(noはAPI専用・UIには置かない) */
export const LATCH_RESPONSE_VALUES = ["yes", "no", "defer"] as const;
export type LatchResponseValue = (typeof LATCH_RESPONSE_VALUES)[number];

/** 各種上限値。docs/04 §5・08 §8・05 §3.1・05 §2.3(アイコン) */
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
	ICON_MAX_BYTES: 1_048_576,
	/** チャット本文の最大文字数(前後の空白を除いた後・F6a設計) */
	MESSAGE_BODY_MAX_LENGTH: 2000,
} as const;

/** チャットの定数(F6a設計) */
export const CHAT = {
	/** 履歴1頁の件数 */
	MESSAGE_PAGE_SIZE: 50,
	/** WebSocket接続チケットの有効秒数(発行から) */
	WS_TICKET_TTL_SECONDS: 60,
	/** client_idの最大文字数 */
	CLIENT_ID_MAX_LENGTH: 64,
} as const;

/** WebSocketのerrorフレームのコード(F6a設計) */
export const CHAT_ERROR_CODES = [
	"read_only",
	"invalid_message",
	"internal",
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** つながりIntentの期限選択肢(日)。docs/05 §2.2(expires_at: 7/30/90選択) */
export const EXPIRY_CHOICES_DAYS = [7, 30, 90] as const;

/** つながりIntentの既定期限(日)。docs/05 §2.2(既定30日) */
export const CONNECTION_DEFAULT_EXPIRY_DAYS = 30 as const;

/** 機会Intentの既定TTL(時間)。start+3時間。docs/05 §2.2(機会=既定start+3h) */
export const OCCASION_DEFAULT_TTL_HOURS = 3 as const;

/** 機会Intentのstarts_at上限(now+7日以内)。docs/05 §2.2(実装で検証) */
export const OCCASION_STARTS_AT_MAX_DAYS_AHEAD = 7 as const;

/** 参加人数の下限・上限。docs/05 §2.2(participants_min/max)・06(2〜4人内) */
export const PARTICIPANTS_MIN = 2 as const;
export const PARTICIPANTS_MAX = 4 as const;

/** 制約の最大項目数・1項目の最大長(ハード/ソフト/否定共通)。docs/05 §2.2(*_constraints) */
export const CONSTRAINT_MAX_ITEMS = 10 as const;
export const CONSTRAINT_ITEM_MAX_LENGTH = 40 as const;

/** 地域添付の半径範囲(m)。docs/05 §2.2(geo_radius_m)・04(地理の実装) */
export const GEO_RADIUS_MIN_M = 100 as const;
export const GEO_RADIUS_MAX_M = 100_000 as const;

/** 予算の上限(円)。docs/05 §2.2(budget_min/max) */
export const BUDGET_MAX = 9_999_999 as const;

/**
 * マッチングパイプラインの定数。値の正本は docs/06(§2〜§4)・05 §2.3(ベクトル削除)・
 * §2.6(候補保持)・07 §4(埋め込み)。単位は名前の接尾辞どおり
 * (MS=ミリ秒・SECONDS=秒・DAYS=日)。
 */
export const PIPELINE = {
	// 1回の実行(キューのバッチ1つ・毎分Cron1回)で書く計測のdata pointの上限。
	// Workersの1回の呼び出しのAnalytics Engineの書き込みは250件までのため手前に置く(#28)
	METRICS_WRITES_PER_INVOCATION: 240,
	// Layer 2 Candidate Retrievalの取り出し幅(topK)。docs/06 §3
	TOP_K_RETRIEVAL: 100,
	// Layer 1通過後の次層への引き渡し上限(K_v)。docs/06 §3
	LAYER1_OUTPUT_MAX: 50,
	// Layer 3のLayer 4への引き渡し上限(K_c)。docs/06 §3
	LAYER3_OUTPUT_MAX: 20,
	// 更新イベントの遅延配信(秒)。docs/06 §2・04 §4
	UPDATE_EVENT_DELAY_SECONDS: 10,
	// 同一Intentの再評価抑制(30分・last_evaluated_at)。docs/06 §4
	REEVALUATION_SUPPRESSION_MS: 30 * 60_000,
	// catch-upの対象とする期限前の窓(expires_atまで2時間以内)。docs/06 §4
	CATCH_UP_WINDOW_MS: 2 * 60 * 60_000,
	// 機会IntentのBucket幅(starts_atの30分刻み)。docs/06 §4
	BUCKET_WIDTH_MS: 30 * 60_000,
	// 機会の時間重なり判定の下限(15分以上)。docs/06 §3
	TIME_OVERLAP_MIN_MS: 15 * 60_000,
	// 期限切れIntentのベクトル削除までの猶予(期限+7日)。docs/05 §2.3・§2.6
	VECTOR_DELETE_DELAY_DAYS: 7,
	// 評価確定後の候補行の保持期間(30日)。docs/05 §2.6
	CANDIDATE_RETENTION_DAYS: 30,
	// つながりIntentの遅延再評価までの経過(active化後10分・1回きり)。docs/06 §4
	DELAYED_REEVAL_AFTER_MS: 10 * 60_000,
	// Vectorize getByIdsの1回あたりの件数上限(20)。超えると呼び出しが失敗する
	VECTOR_GET_MAX: 20,
	// バックフィル回収の対象とする生成後の経過(5分)。docs/06 §4
	BACKFILL_GRACE_MS: 5 * 60_000,
	// Embedding呼び出しのtimeout(5秒・呼び出しの中では再試行しない。失敗はメッセージのretry)。docs/07 §4
	EMBEDDING_TIMEOUT_MS: 5_000,
	// 自分のベクトルが他の評価から見えるまでの確認の間隔(秒・遅延配信の送り直し)。
	// 第1段は反映を待たず、vector_reflectionイベントがこの間隔で確認する
	REFLECTION_DELAYS_S: [2, 4, 8, 16, 30],
	// 反映確認を諦めるまでの上限(8分・超過はfailedにしてCronの回収へ)。
	// 最後の確認は作成から8分30秒より前に終わり、pending残留の掃査(10分)とぶつからない
	REFLECTION_GIVE_UP_MS: 8 * 60_000,
	// Cronのmetadata整合の修復が点検しない埋め込みからの経過(10分)。反映確認が
	// pendingの意思もこの経過によらず点検しない(反映待ちのベクトル不在を欠損と誤らない)
	REPAIR_GRACE_MS: 10 * 60_000,
	// 第1段(埋め込み・upsert・embedded_atの更新・投入)の失敗でメッセージをやり直す遅延(秒)。
	// n回目の配信の失敗はn番目の値(使い切ったら最後の値)。合計(100秒)はpending残留の
	// 掃査(LATCH.PENDING_STALE_MS・10分)より十分に短い。max_retriesを超えたものはDLQでdead
	STAGE1_RETRY_DELAYS_S: [10, 30, 60],
	// 意思を有効にした要求(作成・下書きの有効化)のintent_createdのメッセージを遅らせる秒数。
	// 第1段・第2段は応答の後(waitUntil・上限30秒)に同じ要求の続きで行い、キューのメッセージは
	// それと重ならないよう遅らせて、済んでいなければやり直す役にする(#30・設計 §3.5)
	INLINE_FALLBACK_DELAY_S: 60,
	// 孤立したベクトル(Layer 2のhitのうちD1に意思の行が無いもの)を1回の評価で消す上限(10件)。
	// 意思の行は必ずベクトルより先に作られるため、行の無いhitは削除の後に残ったベクトルと判断できる
	ORPHAN_DELETE_MAX: 10,
	// Cron各処理の1実行あたり処理上限。docs/04 §4
	CRON_BATCH_LIMIT: 500,
	// 直近のベクトルの控え(recent_vectors)を残す埋め込みからの経過(15分・#47)。
	// 反映確認の打ち切り(REFLECTION_GIVE_UP_MS・8分)より長い余裕。過ぎた行は毎分Cronの保持期間の処理で消す
	RECENT_VECTOR_TTL_MS: 15 * 60_000,
} as const;

/**
 * 提案化(Layer 4〜5・提案生成)の定数。値の正本は docs/06 §5〜§7・01 §8・§10。
 * 1日6件の通知上限は LIMITS.NOTIFICATIONS_PER_DAY、Jev予算は LIMITS.JEV_* を使う。
 * 単位は名前の接尾辞どおり(MS=ミリ秒・DAYS=日)。
 */
export const LATCH = {
	// 提案する下限(L > 0.60。0.60ちょうどは提案しない)。docs/06 §5
	THRESHOLD: 0.6,
	// 較正係数C(MVPは1)。docs/06 §5
	CALIBRATION_C: 1,
	// 1イベントあたりのJev呼び出し上限(K_j)。docs/06 §5
	JEV_CALLS_PER_EVENT: 8,
	// 1Intentの同時進行LATCH数の上限。docs/01 §8
	CONCURRENT_PER_INTENT: 3,
	// 機会: 対象時刻まで75分未満なら提案しない。docs/01 §8
	OCCASION_MIN_LEAD_MS: 75 * 60_000,
	// 機会の回答期限: 提示+15分を下限とする。docs/01 §10
	OCCASION_DEADLINE_MIN_MS: 15 * 60_000,
	// 機会の回答期限: 提示+2時間を上限とする。docs/01 §10
	OCCASION_DEADLINE_MAX_MS: 2 * 60 * 60_000,
	// 機会の回答期限: 対象時刻の60分前を超えない。docs/01 §10
	OCCASION_DEADLINE_BEFORE_START_MS: 60 * 60_000,
	// つながりの回答期限: 提示+24時間。docs/01 §10
	CONNECTION_DEADLINE_MS: 24 * 60 * 60_000,
	// 見送り後の再提案抑制の上限(24時間)。docs/01 §8
	REPROPOSAL_SUPPRESSION_MAX_MS: 24 * 60 * 60_000,
	// circuit breaker: 失敗を数える窓(5分)。docs/06 §5
	BREAKER_WINDOW_MS: 5 * 60_000,
	// circuit breaker: 窓内の連続失敗でオープンする回数。docs/06 §5
	BREAKER_FAILURES: 10,
	// circuit breaker: オープンの継続(30分)。docs/06 §5
	BREAKER_OPEN_MS: 30 * 60_000,
	// Jev予算アラートの閾値(上限の80%)。docs/06 §6
	BUDGET_ALERT_RATIO: 0.8,
	// usage_countersの保持期間(90日)。docs/05 §2.6
	COUNTER_RETENTION_DAYS: 90,
	// pending(保留中)残留の掃査対象とする経過(10分)。docs/06 §4
	PENDING_STALE_MS: 10 * 60_000,
	// バックフィルで連続失敗が何件で打ち切るか。docs/06 §4
	BACKFILL_FAILURE_ABORT: 5,
	// グループLATCH: 1イベントで扱う候補Poolの最大人数。docs/06 §3
	GROUP_POOL_MAX: 15,
	// グループLATCH: 集合の人数下限(3人)。docs/06 §3
	GROUP_SIZE_MIN: 3,
	// グループLATCH: 集合の人数上限(4人)。docs/06 §3
	GROUP_SIZE_MAX: 4,
	// 1対1に最低限保証するJev呼び出し回数。docs/06 §3
	JEV_ONE_ON_ONE_MIN: 4,
	// つながりLATCHのcompleted: 最終メッセージ(0件ならmatched時刻)から90日。docs/01 §8
	CONNECTION_QUIET_MS: 90 * 24 * 60 * 60_000,
	// 機会LATCHのcompleted: 対象時刻から3時間。docs/01 §8(2026-10-21オーナー裁定)
	OCCASION_COMPLETE_AFTER_START_MS: 3 * 60 * 60_000,
} as const;

/** 見送り(defer)の理由。回答APIのreasonに使う。docs/05 §3 */
export const DEFER_REASONS = [
	"no_capacity",
	"schedule_mismatch",
	"just_not_now",
	"other",
] as const;
export type DeferReason = (typeof DEFER_REASONS)[number];

/** 通報の理由。docs/05 §3・F7a設計 §3.2 */
export const REPORT_REASONS = [
	"spam",
	"harassment",
	"inappropriate",
	"other",
] as const;
export type ReportReasonValue = (typeof REPORT_REASONS)[number];

/** 通報の対象。docs/05 §3・F7a設計 §3.2 */
export const REPORT_TARGETS = [
	"proposal",
	"profile",
	"icon",
	"message",
] as const;
export type ReportTargetValue = (typeof REPORT_TARGETS)[number];

/** Queuesのキューメッセージ本体。event_type等の詳細はD1のmatch_events行から読む */
export interface MatchQueueMessage {
	event_id: string;
	/** 第1段が計算した起点Intentのベクトル(第2段が反映を待たず評価に使う) */
	vector?: number[];
}

/** Embeddingモデル識別子(real=Workers AI)。intents.embedding_modelへ記録する。docs/07 §4 */
export const EMBEDDING_MODEL_REAL = "@cf/baai/bge-m3" as const;

/** Embeddingモデル識別子(stub=決定的擬似ベクトル)。intents.embedding_modelへ記録する。docs/07 §4 */
export const EMBEDDING_MODEL_STUB = "stub-sha256-v1" as const;
