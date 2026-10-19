import { describe, expect, it } from "vitest";
import {
	BUDGET_MAX,
	CATEGORIES,
	CONNECTION_DEFAULT_EXPIRY_DAYS,
	CONSTRAINT_ITEM_MAX_LENGTH,
	CONSTRAINT_MAX_ITEMS,
	EMBEDDING_MODEL_REAL,
	EMBEDDING_MODEL_STUB,
	ERROR_CODES,
	EXPIRY_CHOICES_DAYS,
	GEO_RADIUS_MAX_M,
	GEO_RADIUS_MIN_M,
	INTENT_FORMS,
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
	it("docs/05 §3.1の13種と順不同で等しい", () => {
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
		});
	});
});

describe("PIPELINE", () => {
	it("docs/06・05 §2.3・§2.6・07 §4のパイプライン定数と等しい", () => {
		expect(PIPELINE).toEqual({
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
			BACKFILL_GRACE_MS: 300_000,
			EMBEDDING_TIMEOUT_MS: 5_000,
			EMBED_CONFIRM_INTERVAL_MS: 500,
			EMBED_CONFIRM_TIMEOUT_MS: 5_000,
			CRON_BATCH_LIMIT: 500,
		});
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
