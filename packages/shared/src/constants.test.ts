import { describe, expect, it } from "vitest";
import {
	BUDGET_MAX,
	CATEGORIES,
	CHAT,
	CHAT_ERROR_CODES,
	CONNECTION_DEFAULT_EXPIRY_DAYS,
	CONSTRAINT_ITEM_MAX_LENGTH,
	CONSTRAINT_MAX_ITEMS,
	DEFER_REASONS,
	EMBEDDING_MODEL_REAL,
	EMBEDDING_MODEL_STUB,
	ERROR_CODES,
	ERROR_HTTP_STATUS,
	EXPIRY_CHOICES_DAYS,
	GEO_RADIUS_MAX_M,
	GEO_RADIUS_MIN_M,
	INTENT_FORMS,
	LATCH,
	LIMITS,
	type MatchQueueMessage,
	OCCASION_DEFAULT_TTL_HOURS,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
	PIPELINE,
} from "./constants";

describe("INTENT_FORMS", () => {
	it("つながり・機会の2フォームをこの順で定義する", () => {
		expect(INTENT_FORMS).toEqual(["connection", "occasion"]);
	});
});

describe("CATEGORIES", () => {
	it("15種を定義し「その他」を含む", () => {
		expect(CATEGORIES.length).toBe(15);
		expect(CATEGORIES).toContain("その他");
	});
});

describe("ERROR_CODES", () => {
	it("docs/05 §3.1の14種と順不同で等しい", () => {
		expect([...ERROR_CODES].sort()).toEqual(
			[
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
			].sort(),
		);
	});
});

describe("Intent定数", () => {
	it("docs/05 §2.2の期限・人数・添付まわりの値と等しい", () => {
		expect(EXPIRY_CHOICES_DAYS).toEqual([7, 30, 90]);
		expect(CONNECTION_DEFAULT_EXPIRY_DAYS).toBe(30);
		expect(OCCASION_DEFAULT_TTL_HOURS).toBe(3);
		expect(OCCASION_STARTS_AT_MAX_DAYS_AHEAD).toBe(7);
		expect(PARTICIPANTS_MIN).toBe(2);
		expect(PARTICIPANTS_MAX).toBe(4);
		expect(CONSTRAINT_MAX_ITEMS).toBe(10);
		expect(CONSTRAINT_ITEM_MAX_LENGTH).toBe(40);
		expect(GEO_RADIUS_MIN_M).toBe(100);
		expect(GEO_RADIUS_MAX_M).toBe(100_000);
		expect(BUDGET_MAX).toBe(9_999_999);
	});
});

describe("LIMITS", () => {
	it("docs/04 §5・08 §8・05 §3.1の上限値と等しい", () => {
		expect(LIMITS).toEqual({
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
			MESSAGE_BODY_MAX_LENGTH: 2000,
		});
	});
});

describe("PIPELINE", () => {
	it("docs/06・05 §2.3・§2.6・07 §4のパイプライン定数と等しい", () => {
		expect(PIPELINE).toEqual({
			// 1回の実行の計測の書き込みの上限(出典は06 §7・本文の更新は後の工程)
			METRICS_WRITES_PER_INVOCATION: 240,
			TOP_K_RETRIEVAL: 100,
			LAYER1_OUTPUT_MAX: 50,
			LAYER3_OUTPUT_MAX: 20,
			UPDATE_EVENT_DELAY_SECONDS: 10,
			// 以下の期待値は実装側の式(30 * 60_000等)を展開した数値で比較する
			REEVALUATION_SUPPRESSION_MS: 1_800_000,
			CATCH_UP_WINDOW_MS: 7_200_000,
			BUCKET_WIDTH_MS: 1_800_000,
			TIME_OVERLAP_MIN_MS: 900_000,
			VECTOR_DELETE_DELAY_DAYS: 7,
			CANDIDATE_RETENTION_DAYS: 30,
			DELAYED_REEVAL_AFTER_MS: 600_000,
			VECTOR_GET_MAX: 20,
			BACKFILL_GRACE_MS: 300_000,
			EMBEDDING_TIMEOUT_MS: 5_000,
			REFLECTION_DELAYS_S: [2, 4, 8, 16, 30],
			REFLECTION_GIVE_UP_MS: 480_000,
			REPAIR_GRACE_MS: 600_000,
			STAGE1_RETRY_DELAYS_S: [10, 30, 60],
			STAGE1_UPSERT_RETRY_DELAYS_MS: [1_000, 2_000, 4_000],
			INLINE_FALLBACK_DELAY_S: 60,
			ORPHAN_DELETE_MAX: 10,
			CRON_BATCH_LIMIT: 500,
			// 直近のベクトルの控えを残す経過(15分・#47)
			RECENT_VECTOR_TTL_MS: 15 * 60_000,
			// 評価で控えから補う行の上限(50件・#47)
			RECENT_VECTOR_SUPPLEMENT_MAX: 50,
			// 削除・内容の変更の後の保留の解放の時間の予算(20秒・#45)
			RELEASE_AFTER_DELETE_BUDGET_MS: 20_000,
		});
	});

	it("第1段の再試行の遅延の合計は、pending残留の掃査(10分)より短い(#17)", () => {
		const totalMs =
			PIPELINE.STAGE1_RETRY_DELAYS_S.reduce((sum, s) => sum + s, 0) * 1_000;
		expect(totalMs).toBeLessThan(LATCH.PENDING_STALE_MS);
	});
});

describe("Embeddingモデル識別子", () => {
	it("docs/07 §4のモデル識別子と等しい", () => {
		expect(EMBEDDING_MODEL_REAL).toBe("@cf/baai/bge-m3");
		expect(EMBEDDING_MODEL_STUB).toBe("stub-sha256-v1");
	});
});

describe("MatchQueueMessage", () => {
	it("event_idを持つQueuesのメッセージ型として成立する", () => {
		const message: MatchQueueMessage = {
			event_id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
		};
		expect(message.event_id).toBe("01JAAAAAAAAAAAAAAAAAAAAAAA");
	});
});

describe("LATCH(提案化の定数・docs/06 §5〜§7)", () => {
	it("仕様どおりの値を持つ", () => {
		expect(LATCH).toEqual({
			THRESHOLD: 0.6,
			CALIBRATION_C: 1,
			JEV_CALLS_PER_EVENT: 8,
			CONCURRENT_PER_INTENT: 3,
			OCCASION_MIN_LEAD_MS: 75 * 60_000,
			OCCASION_DEADLINE_MIN_MS: 15 * 60_000,
			OCCASION_DEADLINE_MAX_MS: 2 * 60 * 60_000,
			OCCASION_DEADLINE_BEFORE_START_MS: 60 * 60_000,
			CONNECTION_DEADLINE_MS: 24 * 60 * 60_000,
			REPROPOSAL_SUPPRESSION_MAX_MS: 24 * 60 * 60_000,
			BREAKER_WINDOW_MS: 5 * 60_000,
			BREAKER_FAILURES: 10,
			BREAKER_OPEN_MS: 30 * 60_000,
			BUDGET_ALERT_RATIO: 0.8,
			COUNTER_RETENTION_DAYS: 90,
			PENDING_STALE_MS: 10 * 60_000,
			BACKFILL_FAILURE_ABORT: 5,
			GROUP_POOL_MAX: 15,
			GROUP_SIZE_MIN: 3,
			GROUP_SIZE_MAX: 4,
			JEV_ONE_ON_ONE_MIN: 4,
			CONNECTION_QUIET_MS: 90 * 24 * 60 * 60_000,
			OCCASION_COMPLETE_AFTER_START_MS: 3 * 60 * 60_000,
		});
	});
});

describe("DEFER_REASONS", () => {
	it("見送り理由の4種をこの順で定義する", () => {
		expect(DEFER_REASONS).toEqual([
			"no_capacity",
			"schedule_mismatch",
			"just_not_now",
			"other",
		]);
	});
});

describe("チャットの定数(F6a設計)", () => {
	it("UPGRADE_REQUIREDは426", () => {
		expect(ERROR_HTTP_STATUS.UPGRADE_REQUIRED).toBe(426);
	});
	it("本文上限・頁サイズ・チケット有効期間・client_id上限", () => {
		expect(LIMITS.MESSAGE_BODY_MAX_LENGTH).toBe(2000);
		expect(CHAT.MESSAGE_PAGE_SIZE).toBe(50);
		expect(CHAT.WS_TICKET_TTL_SECONDS).toBe(60);
		expect(CHAT.CLIENT_ID_MAX_LENGTH).toBe(64);
	});
	it("チャットのエラーコードは3種", () => {
		expect(CHAT_ERROR_CODES).toEqual([
			"read_only",
			"invalid_message",
			"internal",
		]);
	});
});
