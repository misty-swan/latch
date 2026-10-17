import { describe, expect, it } from "vitest";
import { CATEGORIES, ERROR_CODES, INTENT_FORMS, LIMITS } from "./constants";

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
		});
	});
});
