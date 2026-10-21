import {
	CONNECTION_DEFAULT_EXPIRY_DAYS,
	EXPIRY_CHOICES_DAYS,
	OCCASION_DEFAULT_TTL_HOURS,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
} from "@latch/shared";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock/clock";
import { connectionExpiry, MS_PER_DAY, occasionDefaultExpiry } from "./expiry";
import { isAlcoholRestricted, validateIntentForActive } from "./validation";

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

// 時刻の規律(docs/04 §4): テストはfixedClockでnow=2026-10-18T00:00:00Zに固定する
const now = fixedClock(new Date("2026-10-18T00:00:00Z")).now();

describe("connectionExpiry(docs/05 §2.2: つながり=active化時刻+7/30/90日)", () => {
	it("日数未指定は既定30日後", () => {
		expect(connectionExpiry(now).getTime()).toBe(
			now.getTime() + CONNECTION_DEFAULT_EXPIRY_DAYS * MS_PER_DAY,
		);
	});

	it("7/30/90日の指定はそれぞれの日数後", () => {
		for (const days of EXPIRY_CHOICES_DAYS) {
			expect(connectionExpiry(now, days).getTime()).toBe(
				now.getTime() + days * MS_PER_DAY,
			);
		}
	});
});

describe("occasionDefaultExpiry(docs/05 §2.2: 機会=既定start+3時間)", () => {
	it("start+3時間を返す", () => {
		const startsAt = new Date(now.getTime() + 2 * MS_PER_DAY);
		expect(occasionDefaultExpiry(startsAt).getTime()).toBe(
			startsAt.getTime() + OCCASION_DEFAULT_TTL_HOURS * MS_PER_HOUR,
		);
	});
});

describe("validateIntentForActive(docs/05 §2.2: active化検証)", () => {
	it("つながり最小構成(form/topicのみ)はok・expiresAt=now+30日", () => {
		const result = validateIntentForActive(
			{ form: "connection", topic: "ランニング仲間" },
			now,
		);
		expect(result).toEqual({
			ok: true,
			expiresAt: new Date(
				now.getTime() + CONNECTION_DEFAULT_EXPIRY_DAYS * MS_PER_DAY,
			),
		});
	});

	it("expiresInDaysの指定でnow+7日/now+30日/now+90日", () => {
		for (const days of EXPIRY_CHOICES_DAYS) {
			const result = validateIntentForActive(
				{ form: "connection", topic: "x", expiresInDays: days },
				now,
			);
			expect(result).toEqual({
				ok: true,
				expiresAt: new Date(now.getTime() + days * MS_PER_DAY),
			});
		}
	});

	it("機会(starts_at=now+2日)はok・expiresAt=start+3時間(既定)", () => {
		const startsAt = new Date(now.getTime() + 2 * MS_PER_DAY);
		const result = validateIntentForActive(
			{ form: "occasion", topic: "テニス合宿", startsAt },
			now,
		);
		expect(result).toEqual({
			ok: true,
			expiresAt: new Date(
				startsAt.getTime() + OCCASION_DEFAULT_TTL_HOURS * MS_PER_HOUR,
			),
		});
	});

	it("機会+明示expires_at(start+5時間)はok・その値(draft保存値より優先)", () => {
		const startsAt = new Date(now.getTime() + 2 * MS_PER_DAY);
		const explicitExpiresAt = new Date(startsAt.getTime() + 5 * MS_PER_HOUR);
		const storedExpiresAt = new Date(startsAt.getTime() + 4 * MS_PER_HOUR);
		const result = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt,
				storedExpiresAt,
				explicitExpiresAt,
			},
			now,
		);
		expect(result).toEqual({ ok: true, expiresAt: explicitExpiresAt });
	});

	it("機会+storedExpiresAt(draft保存済み)はactive化に期限指定が無ければその値", () => {
		const startsAt = new Date(now.getTime() + 2 * MS_PER_DAY);
		const storedExpiresAt = new Date(startsAt.getTime() + 4 * MS_PER_HOUR);
		const result = validateIntentForActive(
			{ form: "occasion", topic: "x", startsAt, storedExpiresAt },
			now,
		);
		expect(result).toEqual({ ok: true, expiresAt: storedExpiresAt });
	});

	it("機会+明示期限がstart以前はNG・expires_at_before_start(同時刻も含む)", () => {
		const startsAt = new Date(now.getTime() + 2 * MS_PER_DAY);
		const before = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt,
				explicitExpiresAt: new Date(startsAt.getTime() - MS_PER_HOUR),
			},
			now,
		);
		expect(before).toEqual({ ok: false, reasons: ["expires_at_before_start"] });

		const sameMoment = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt,
				explicitExpiresAt: new Date(startsAt.getTime()),
			},
			now,
		);
		expect(sameMoment).toEqual({
			ok: false,
			reasons: ["expires_at_before_start"],
		});
	});

	it("form無しはform_required・topic無しはtopic_required・両方欠けなら両方列挙", () => {
		expect(validateIntentForActive({}, now)).toEqual({
			ok: false,
			reasons: ["form_required", "topic_required"],
		});
		expect(validateIntentForActive({ form: "connection" }, now)).toEqual({
			ok: false,
			reasons: ["topic_required"],
		});
		expect(validateIntentForActive({ topic: "x" }, now)).toEqual({
			ok: false,
			reasons: ["form_required"],
		});
		expect(
			validateIntentForActive({ form: "connection", topic: "" }, now),
		).toEqual({ ok: false, reasons: ["topic_required"] });
	});

	it("機会でstarts_at無しはstarts_at_required(topic欠けとは併存して列挙)", () => {
		expect(
			validateIntentForActive({ form: "occasion", topic: "x" }, now),
		).toEqual({ ok: false, reasons: ["starts_at_required"] });
		expect(validateIntentForActive({ form: "occasion" }, now)).toEqual({
			ok: false,
			reasons: ["topic_required", "starts_at_required"],
		});
	});

	it("つながりにstarts_at・alcohol_involved=true・明示expires_atは3理由同時", () => {
		const result = validateIntentForActive(
			{
				form: "connection",
				topic: "x",
				startsAt: new Date(now.getTime() + MS_PER_DAY),
				alcoholInvolved: true,
				explicitExpiresAt: new Date(now.getTime() + MS_PER_DAY),
			},
			now,
		);
		expect(result).toEqual({
			ok: false,
			reasons: [
				"starts_at_not_allowed",
				"alcohol_not_allowed",
				"expires_at_not_allowed",
			],
		});
	});

	it("機会のstarts_atが過去やnow+7日超はstarts_at_out_of_range", () => {
		const tooEarly = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt: new Date(now.getTime() - MS_PER_MINUTE),
			},
			now,
		);
		expect(tooEarly).toEqual({
			ok: false,
			reasons: ["starts_at_out_of_range"],
		});

		const tooLate = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt: new Date(
					now.getTime() +
						OCCASION_STARTS_AT_MAX_DAYS_AHEAD * MS_PER_DAY +
						MS_PER_MINUTE,
				),
			},
			now,
		);
		expect(tooLate).toEqual({ ok: false, reasons: ["starts_at_out_of_range"] });
	});

	it("機会のstarts_at境界(nowちょうど・now+7日ちょうど)はok", () => {
		const atNow = validateIntentForActive(
			{ form: "occasion", topic: "x", startsAt: now },
			now,
		);
		expect(atNow.ok).toBe(true);

		const atMax = validateIntentForActive(
			{
				form: "occasion",
				topic: "x",
				startsAt: new Date(
					now.getTime() + OCCASION_STARTS_AT_MAX_DAYS_AHEAD * MS_PER_DAY,
				),
			},
			now,
		);
		expect(atMax.ok).toBe(true);
	});
});

describe("isAlcoholRestricted(F7a設計 §4・docs/08 §8: 20歳未満の飲酒を含む機会Intent)", () => {
	// now=2026-10-18T00:00:00Z=JST 2026-10-18 09:00。2006-10-18生まれは当日に満20歳
	const cases: Array<{
		name: string;
		form: "occasion" | "connection" | null;
		alcoholInvolved: boolean;
		birthDate: string;
		expected: boolean;
	}> = [
		{
			name: "occasion+飲酒+19歳は制限",
			form: "occasion",
			alcoholInvolved: true,
			birthDate: "2007-10-18",
			expected: true,
		},
		{
			name: "誕生日前日(満20歳の前日)は制限",
			form: "occasion",
			alcoholInvolved: true,
			birthDate: "2006-10-19",
			expected: true,
		},
		{
			name: "誕生日当日(満20歳)は制限なし",
			form: "occasion",
			alcoholInvolved: true,
			birthDate: "2006-10-18",
			expected: false,
		},
		{
			name: "connectionは飲酒でも制限なし",
			form: "connection",
			alcoholInvolved: true,
			birthDate: "2007-10-18",
			expected: false,
		},
		{
			name: "formがnullは制限なし",
			form: null,
			alcoholInvolved: true,
			birthDate: "2007-10-18",
			expected: false,
		},
		{
			name: "飲酒なしは制限なし",
			form: "occasion",
			alcoholInvolved: false,
			birthDate: "2007-10-18",
			expected: false,
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			expect(
				isAlcoholRestricted(
					{ form: c.form, alcoholInvolved: c.alcoholInvolved },
					c.birthDate,
					now,
				),
			).toBe(c.expected);
		});
	}
});
