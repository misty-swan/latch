/**
 * submit(confirm値→Intent保存リクエストの組立)の単体試験。
 * つながり/機会で期限の送り方(expires_in_days/expires_at)が替わること・
 * draft→active化のPATCH本文・クライアント検証・JST固定の時刻変換を確かめる
 */

import {
	createIntentRequestSchema,
	parseResponseSchema,
	patchIntentRequestSchema,
} from "@latch/shared";
import { describe, expect, it } from "vitest";
import {
	buildCreateIntentRequest,
	buildPatchIntentRequest,
	type ConfirmValues,
	connectionExpiryCaption,
	EMPTY_PARSE,
	formatExpiryClockJst,
	formatMonthDayJst,
	formatStartJst,
	isoFromLocalInput,
	localInputFromIso,
	occasionDefaultExpiryIso,
	validateConfirmValues,
} from "./submit";

const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。";

const connectionValues = (
	overrides: Partial<ConfirmValues> = {},
): ConfirmValues => ({
	form: "connection",
	topic: "イラスト仲間",
	category: null,
	startLocal: "",
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	softConstraints: [],
	alcoholInvolved: false,
	expiresInDays: 30,
	...overrides,
});

const occasionValues = (
	overrides: Partial<ConfirmValues> = {},
): ConfirmValues => ({
	form: "occasion",
	topic: "軽く飲みに行く",
	category: "食・飲み",
	startLocal: "2026-10-21T20:00",
	participants: { min: 2, max: 4, includes_owner: true },
	budget: { min: 5000, max: 5000, currency: "JPY" },
	softConstraints: ["お酒好きと飲みたい"],
	alcoholInvolved: true,
	expiresInDays: 30,
	...overrides,
});

describe("buildCreateIntentRequest", () => {
	it("つながりの新規保存はstatus=active・expires_in_daysで・time・budget・お酒はnull/false", () => {
		const body = buildCreateIntentRequest(connectionValues(), WORDS);

		expect(body).toEqual({
			form: "connection",
			topic: "イラスト仲間",
			category: null,
			time: null,
			geo: null,
			participants: { min: 2, max: 2, includes_owner: true },
			budget: null,
			hard_constraints: [],
			soft_constraints: [],
			negative_constraints: [],
			notification_level: "proposals_only",
			alcohol_involved: false,
			raw_text: WORDS,
			status: "active",
			expires_in_days: 30,
		});
		expect(body === null || "expires_at" in body).toBe(false);
		expect(body === null || "version" in body).toBe(false);
	});

	it("機会の新規保存はtime.startとexpires_at=start+3時間で・expires_in_daysを持たない", () => {
		const body = buildCreateIntentRequest(occasionValues(), WORDS);

		expect(body).toEqual({
			form: "occasion",
			topic: "軽く飲みに行く",
			category: "食・飲み",
			time: { start: "2026-10-21T11:00:00.000Z", end: null },
			geo: null,
			participants: { min: 2, max: 4, includes_owner: true },
			budget: { min: 5000, max: 5000, currency: "JPY" },
			hard_constraints: [],
			soft_constraints: ["お酒好きと飲みたい"],
			negative_constraints: [],
			notification_level: "proposals_only",
			alcohol_involved: true,
			raw_text: WORDS,
			status: "active",
			expires_at: "2026-10-21T14:00:00.000Z",
		});
		expect(body === null || "expires_in_days" in body).toBe(false);
	});

	it("機会の予算編集でminがmaxを超えないように丸めた値も契約どおりに組める", () => {
		const body = buildCreateIntentRequest(
			occasionValues({ budget: { min: 3000, max: 3000, currency: "JPY" } }),
			WORDS,
		);
		expect(body?.budget).toEqual({ min: 3000, max: 3000, currency: "JPY" });
	});

	it("主題が空・機会で日時が空や不正のときはnull(送信前に止める)", () => {
		expect(
			buildCreateIntentRequest(connectionValues({ topic: "　" }), WORDS),
		).toBeNull();
		expect(
			buildCreateIntentRequest(occasionValues({ startLocal: "" }), WORDS),
		).toBeNull();
		expect(
			buildCreateIntentRequest(occasionValues({ startLocal: "" }), WORDS),
		).toBeNull();
		// 日付のみ(時刻なし)はdatetime-localの値として不完全
		expect(
			buildCreateIntentRequest(
				occasionValues({ startLocal: "2026-10-21" }),
				WORDS,
			),
		).toBeNull();
	});
});

describe("buildPatchIntentRequest", () => {
	it("draft→active化は同じ形の全項目+status=activeで・patchスキーマを通る(versionは送らない)", () => {
		const body = buildPatchIntentRequest(occasionValues(), WORDS);

		expect(patchIntentRequestSchema.safeParse(body).success).toBe(true);
		expect(createIntentRequestSchema.safeParse(body).success).toBe(true);
		expect(body?.status).toBe("active");
		expect(body === null || "version" in body).toBe(false);
		expect(body?.time).toEqual({
			start: "2026-10-21T11:00:00.000Z",
			end: null,
		});
	});

	it("つながりのdraft→active化はexpires_in_daysを運ぶ", () => {
		const body = buildPatchIntentRequest(
			connectionValues({ expiresInDays: 90 }),
			WORDS,
		);
		expect(patchIntentRequestSchema.safeParse(body).success).toBe(true);
		expect(body?.expires_in_days).toBe(90);
	});
});

describe("validateConfirmValues", () => {
	const now = new Date("2026-10-19T03:00:00.000Z"); // JST 2026-10-19 12:00

	it("主題が空(空白のみ)のときは主題の案内を返す", () => {
		expect(
			validateConfirmValues(connectionValues({ topic: "　" }), now),
		).toEqual({
			topic: "主題を入力してください",
		});
	});

	it("機会で日時が空・過去・7日超えのときは日時の案内を返す", () => {
		expect(
			validateConfirmValues(occasionValues({ startLocal: "" }), now).start,
		).toBe("日時を入力してください。機会は日時が必須です");
		expect(
			validateConfirmValues(
				occasionValues({ startLocal: "2026-10-19T11:00" }),
				now,
			).start,
		).toBe("日時は現在以降で指定してください");
		expect(
			validateConfirmValues(
				occasionValues({ startLocal: "2026-10-27T12:00" }),
				now,
			).start,
		).toBe("日時は現在から7日以内で指定してください");
	});

	it("つながりと妥当な機会はエラー無し", () => {
		expect(validateConfirmValues(connectionValues(), now)).toEqual({});
		expect(validateConfirmValues(occasionValues(), now)).toEqual({});
	});
});

describe("時刻の変換と整形(JST固定・04 §4)", () => {
	it("ISOをJSTの壁時計としてdatetime-local値へ変換する", () => {
		expect(localInputFromIso("2026-10-21T20:00:00+09:00")).toBe(
			"2026-10-21T20:00",
		);
		expect(localInputFromIso("2026-10-21T11:00:00.000Z")).toBe(
			"2026-10-21T20:00",
		);
		expect(localInputFromIso("not-iso")).toBe("");
	});

	it("datetime-local値を+09:00付きの実時刻としてISO(Z)へ変換する", () => {
		expect(isoFromLocalInput("2026-10-21T20:00")).toBe(
			"2026-10-21T11:00:00.000Z",
		);
		expect(isoFromLocalInput("2026-10-21T20:00:00")).toBeNull();
		expect(isoFromLocalInput("")).toBeNull();
	});

	it("機会の既定期限はstart+3時間(docs/05 §2.2)", () => {
		expect(occasionDefaultExpiryIso("2026-10-21T11:00:00.000Z")).toBe(
			"2026-10-21T14:00:00.000Z",
		);
	});

	it("日付はM月D日・期限の短い表示は当日なら「今日 時:分」", () => {
		// 2026-11-15T03:00Z = JST 2026-11-15 12:00
		expect(formatMonthDayJst("2026-11-15T03:00:00.000Z")).toBe("11月15日");
		expect(
			formatExpiryClockJst(
				"2026-11-15T03:00:00.000Z",
				new Date("2026-11-15T04:00:00.000Z"),
			),
		).toBe("今日 12:00");
		expect(
			formatExpiryClockJst(
				"2026-11-15T03:00:00.000Z",
				new Date("2026-11-14T14:00:00.000Z"), // JST 11-14 23:00 = 前日
			),
		).toBe("11月15日 12:00");
	});

	it("datetime-local値の短い表示は当日なら「今日 時:分〜」(JSTの壁時計)", () => {
		// now=2026-10-19T03:00Z は JST 2026-10-19 12:00
		expect(
			formatStartJst("2026-10-19T20:00", new Date("2026-10-19T03:00:00.000Z")),
		).toBe("今日 20:00〜");
		expect(
			formatStartJst("2026-10-21T20:00", new Date("2026-10-19T03:00:00.000Z")),
		).toBe("10月21日 20:00〜");
		expect(formatStartJst("", new Date())).toBeNull();
	});

	it("つながりの期限captionはexpires_at_optionsの日付を使う(欠損時はnow+日数へ倒す)", () => {
		const options = [
			"2026-10-26T12:00:00+09:00",
			"2026-11-18T12:00:00+09:00",
			"2027-01-17T12:00:00+09:00",
		];
		expect(connectionExpiryCaption(options, 7)).toBe("10月26日");
		expect(connectionExpiryCaption(options, 30)).toBe("11月18日");
		expect(connectionExpiryCaption(options, 90)).toBe("1月17日");
		expect(
			connectionExpiryCaption([], 30, new Date("2026-02-01T00:00:00.000Z")),
		).toBe("3月3日");
	});
});

describe("EMPTY_PARSE(手入力モードの空の構造化値)", () => {
	it("parseResponseSchemaを通る", () => {
		expect(parseResponseSchema.parse(EMPTY_PARSE)).toEqual(EMPTY_PARSE);
		expect(EMPTY_PARSE.form).toBe("connection");
		expect(EMPTY_PARSE.time).toBeNull();
	});
});
