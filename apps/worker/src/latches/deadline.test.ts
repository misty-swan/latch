/**
 * 回答期限・75分判定の単体試験(F4a設計 §3.4・docs/01 §8)。
 */

import { describe, expect, it } from "vitest";
import type { intents } from "../db/schema";
import {
	isTooLate,
	minExpiry,
	occasionTargetAt,
	responseDeadline,
} from "./deadline";

type Row = typeof intents.$inferSelect;

const at = (hhmm: string): Date => new Date(`2026-06-01T${hhmm}:00Z`);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** 時刻だけが関係する試験用に、型を満たす最小の行を作る */
const row = (overrides: Partial<Row>): Row => overrides as Row;

describe("responseDeadline(機会)", () => {
	const presented = at("10:00");
	const farExpiry = at("23:00");

	it("対象13:00 → 12:00(提示+2時間と対象-60分の早い方)", () => {
		expect(
			responseDeadline("occasion", presented, at("13:00"), farExpiry),
		).toEqual(at("12:00"));
	});

	it("対象11:20 → 10:20(対象-60分が提示+15分より遅い)", () => {
		expect(
			responseDeadline("occasion", presented, at("11:20"), farExpiry),
		).toEqual(at("10:20"));
	});

	it("対象-60分が提示+15分より早いときは提示+15分で下限が掛かる", () => {
		expect(
			responseDeadline("occasion", presented, at("10:30"), farExpiry),
		).toEqual(at("10:15"));
	});

	it("Intent期限11:00・対象14:00 → 11:00(期限が上限)", () => {
		expect(
			responseDeadline("occasion", presented, at("14:00"), at("11:00")),
		).toEqual(at("11:00"));
	});

	it("機会で対象時刻がnullは不変条件違反として例外", () => {
		expect(() =>
			responseDeadline("occasion", presented, null, farExpiry),
		).toThrow();
	});
});

describe("responseDeadline(つながり)", () => {
	const presented = at("10:00");

	it("提示+24時間", () => {
		expect(
			responseDeadline(
				"connection",
				presented,
				null,
				new Date(presented.getTime() + 48 * HOUR),
			),
		).toEqual(new Date(presented.getTime() + 24 * HOUR));
	});

	it("Intent期限が+10時間なら+10時間", () => {
		const expiry = new Date(presented.getTime() + 10 * HOUR);
		expect(responseDeadline("connection", presented, null, expiry)).toEqual(
			expiry,
		);
	});
});

describe("isTooLate", () => {
	const now = at("10:00");

	it("74分59秒前はtrue", () => {
		expect(isTooLate(new Date(now.getTime() + 74 * MIN + 59_000), now)).toBe(
			true,
		);
	});

	it("ちょうど75分前はfalse", () => {
		expect(isTooLate(new Date(now.getTime() + 75 * MIN), now)).toBe(false);
	});
});

describe("occasionTargetAt・minExpiry", () => {
	it("対象時刻は全員のstarts_atの遅い方(順序に依らない)", () => {
		const a = row({ startsAt: at("12:00") });
		const b = row({ startsAt: at("13:00") });
		expect(occasionTargetAt([a, b])).toEqual(at("13:00"));
		expect(occasionTargetAt([b, a])).toEqual(at("13:00"));
	});

	it("Intent期限の最小値", () => {
		const a = row({ expiresAt: at("15:00") });
		const b = row({ expiresAt: at("14:00") });
		expect(minExpiry([a, b])).toEqual(at("14:00"));
		expect(minExpiry([b, a])).toEqual(at("14:00"));
	});

	it("3人: 対象時刻はstarts_atの最大・期限は最小", () => {
		const a = row({ startsAt: at("12:00"), expiresAt: at("16:00") });
		const b = row({ startsAt: at("13:00"), expiresAt: at("15:00") });
		const c = row({ startsAt: at("12:30"), expiresAt: at("14:30") });
		expect(occasionTargetAt([a, b, c])).toEqual(at("13:00"));
		expect(minExpiry([a, b, c])).toEqual(at("14:30"));
	});
});
