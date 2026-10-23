import { describe, expect, it } from "vitest";
import { subjectsWithIntents } from "../cleanup.mjs";
import {
	accessHeaders,
	bodyFromParse,
	checkTarget,
	parseScale,
	resolveRunId,
	runIdNow,
	scaled,
} from "./target.mjs";

describe("checkTarget", () => {
	it("404(prodなどdev専用サインインが無い宛先)は例外", () => {
		expect(() => checkTarget(404)).toThrow(
			"宛先がstagingではありません(dev専用サインインが使えない)",
		);
	});
	it("通信の失敗(k6のstatus=0)も例外", () => {
		expect(() => checkTarget(0)).toThrow();
	});
	it("200は通る", () => {
		expect(() => checkTarget(200)).not.toThrow();
	});
});

describe("runIdNow", () => {
	it("UTCのYYYYMMDDHHmm(12桁)", () => {
		expect(runIdNow()).toMatch(/^\d{12}$/);
	});
	it("UTCで組み立てる", () => {
		expect(runIdNow(new Date("2026-10-22T06:30:59Z"))).toBe("202610220630");
	});
});

describe("resolveRunId", () => {
	it("指定が無ければ現在時刻から作る", () => {
		expect(resolveRunId(undefined, new Date("2026-01-02T03:04:00Z"))).toBe(
			"202601020304",
		);
		expect(resolveRunId("", new Date("2026-01-02T03:04:00Z"))).toBe(
			"202601020304",
		);
	});
	it("12桁の数字はそのまま使う", () => {
		expect(resolveRunId("202610221530")).toBe("202610221530");
	});
	it("12桁の数字でなければ例外(集計のSQLへ差し込ませない)", () => {
		expect(() => resolveRunId("2026'--")).toThrow();
		expect(() => resolveRunId("20261022153")).toThrow();
	});
});

describe("parseScale・scaled", () => {
	it("既定は1", () => {
		expect(parseScale(undefined)).toBe(1);
		expect(parseScale("")).toBe(1);
	});
	it("正の数を受ける", () => {
		expect(parseScale("0.1")).toBe(0.1);
	});
	it("0以下・数でないものは例外", () => {
		expect(() => parseScale("0")).toThrow();
		expect(() => parseScale("-1")).toThrow();
		expect(() => parseScale("abc")).toThrow();
	});
	it("倍率を掛けて四捨五入し、1を下回らない", () => {
		expect(scaled(100, 0.1)).toBe(10);
		expect(scaled(300, 0.1)).toBe(30);
		expect(scaled(20, 0.01)).toBe(1);
		expect(scaled(100, 1)).toBe(100);
	});
});

describe("bodyFromParse(読み解き確認の[預ける]と同じ本文)", () => {
	const connection = {
		form: "connection",
		topic: " 週末に一緒に散歩できる人を探しています ",
		category: null,
		time: null,
		geo: null,
		participants: { min: 2, max: 2, includes_owner: true },
		budget: null,
		expires_at_options: [],
		alcohol_involved: false,
		warnings: [],
	};

	it("つながりはexpires_in_days=30・status=active", () => {
		const raw = "週末に一緒に散歩できる人を探しています";
		expect(bodyFromParse(connection, raw)).toEqual({
			form: "connection",
			topic: "週末に一緒に散歩できる人を探しています",
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
			raw_text: raw,
			status: "active",
			expires_in_days: 30,
		});
	});

	it("機会は開始+3時間の期限と予算・お酒を運ぶ", () => {
		const body = bodyFromParse(
			{
				...connection,
				form: "occasion",
				time: { start: "2026-10-23T19:00:00+09:00", end: null },
				budget: { min: 3000, max: 3000 },
				alcohol_involved: true,
			},
			"raw",
		);
		expect(body.time).toEqual({ start: "2026-10-23T10:00:00.000Z", end: null });
		expect(body.expires_at).toBe("2026-10-23T13:00:00.000Z");
		expect(body.budget).toEqual({ min: 3000, max: 3000, currency: "JPY" });
		expect(body.alcohol_involved).toBe(true);
		expect(body.expires_in_days).toBeUndefined();
	});

	it("機会で日時が無いものはnull(保存できない)", () => {
		expect(bodyFromParse({ ...connection, form: "occasion" }, "raw")).toBe(
			null,
		);
	});

	it("人数は2〜4人へ丸める", () => {
		const body = bodyFromParse(
			{ ...connection, participants: { min: 1, max: 9 } },
			"raw",
		);
		expect(body.participants).toEqual({ min: 2, max: 4, includes_owner: true });
	});
});

describe("subjectsWithIntents", () => {
	it("load-で始まるsubjectだけを重複なく返す(実行の印を問わない)", () => {
		expect(
			subjectsWithIntents([
				{ auth_subject: "load-202610221530-1" },
				{ auth_subject: "load-202610221530-1" },
				{ auth_subject: "load-202610210900-3" },
				{ auth_subject: "e2e-x" },
			]),
		).toEqual(["load-202610221530-1", "load-202610210900-3"]);
	});
	it("空の結果は空", () => {
		expect(subjectsWithIntents([])).toEqual([]);
	});
});

describe("accessHeaders", () => {
	it("両方の値があればAccessの通行証のヘッダーを作る", () => {
		expect(
			accessHeaders({
				LATCH_ACCESS_CLIENT_ID: "id-x",
				LATCH_ACCESS_CLIENT_SECRET: "secret-x",
			}),
		).toEqual({
			"CF-Access-Client-Id": "id-x",
			"CF-Access-Client-Secret": "secret-x",
		});
	});
	it("片方でも欠ければ空(空文字も欠けた扱い)", () => {
		expect(accessHeaders({ LATCH_ACCESS_CLIENT_ID: "id-x" })).toEqual({});
		expect(accessHeaders({ LATCH_ACCESS_CLIENT_SECRET: "s" })).toEqual({});
		expect(
			accessHeaders({
				LATCH_ACCESS_CLIENT_ID: "id-x",
				LATCH_ACCESS_CLIENT_SECRET: "",
			}),
		).toEqual({});
	});
	it("どちらも無ければ空", () => {
		expect(accessHeaders({})).toEqual({});
	});
});
