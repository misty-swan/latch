import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../clock/clock";
import { recordExternalSend } from "./external-send";

const db = (env as unknown as { DB: D1Database }).DB;

const countOf = async (key: string, period: string): Promise<number | null> => {
	const row = await db
		.prepare(
			"SELECT count FROM usage_counters WHERE scope='external_send' AND key=? AND period=?",
		)
		.bind(key, period)
		.first<{ count: number }>();
	return row?.count ?? null;
};

describe("recordExternalSend(08 §5: 外部送信の日次集計)", () => {
	it("同じ日に2回で2、別の日は別行(JST日付)", async () => {
		const d1 = fixedClock(new Date("2031-03-01T00:00:00+09:00"));
		const d2 = fixedClock(new Date("2031-03-02T00:00:00+09:00"));
		await recordExternalSend(db, d1, "anthropic:parser");
		await recordExternalSend(db, d1, "anthropic:parser");
		await recordExternalSend(db, d2, "anthropic:parser");
		await recordExternalSend(db, d1, "typesafe:jev");
		expect(await countOf("anthropic:parser", "2031-03-01")).toBe(2);
		expect(await countOf("anthropic:parser", "2031-03-02")).toBe(1);
		expect(await countOf("typesafe:jev", "2031-03-01")).toBe(1);
	});

	it("D1が失敗しても例外を外へ出さない", async () => {
		const broken = {
			prepare: () => {
				throw new Error("D1_ERROR");
			},
		} as unknown as D1Database;
		await expect(
			recordExternalSend(
				broken,
				fixedClock(new Date("2031-03-01T00:00:00Z")),
				"anthropic:jev",
			),
		).resolves.toBeUndefined();
	});

	// D1の包み: 先頭から順に、与えた失敗を投げ、尽きたら本物へ流す
	const flaky = (failures: string[]) => {
		let calls = 0;
		const wrapped = {
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					bind: (...args: unknown[]) => {
						const bound = stmt.bind(...args);
						return {
							run: async () => {
								const failure = failures[calls];
								calls += 1;
								if (failure !== undefined) throw new Error(failure);
								return bound.run();
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		return { wrapped, calls: () => calls };
	};

	it("1回目がD1_OVERLOADEDで2回目が成功なら1加算され失敗のログが出ない", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { wrapped, calls } = flaky(["D1_ERROR: D1 DB is overloaded"]);
		await recordExternalSend(
			wrapped,
			fixedClock(new Date("2031-04-01T00:00:00+09:00")),
			"anthropic:parser",
		);
		const logs = spy.mock.calls.map((c) => String(c[0]));
		spy.mockRestore();
		expect(calls()).toBe(2);
		expect(await countOf("anthropic:parser", "2031-04-01")).toBe(1);
		expect(logs.some((l) => l.includes("external_send.record.failed"))).toBe(
			false,
		);
	});

	it("3回とも失敗なら例外を出さず、ログのerror_codeはD1_OVERLOADED", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { wrapped, calls } = flaky([
			"D1_ERROR: D1 DB is overloaded",
			"D1_ERROR: D1 DB is overloaded",
			"D1_ERROR: D1 DB is overloaded",
		]);
		await expect(
			recordExternalSend(
				wrapped,
				fixedClock(new Date("2031-04-02T00:00:00+09:00")),
				"anthropic:parser",
			),
		).resolves.toBeUndefined();
		const logs = spy.mock.calls.map((c) => String(c[0]));
		spy.mockRestore();
		expect(calls()).toBe(3);
		expect(await countOf("anthropic:parser", "2031-04-02")).toBeNull();
		expect(
			logs.some(
				(l) =>
					l.includes("external_send.record.failed") &&
					l.includes('"error_code":"D1_OVERLOADED"'),
			),
		).toBe(true);
	});

	it("D1_CONSTRAINTは1回で諦める", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { wrapped, calls } = flaky([
			"D1_ERROR: UNIQUE constraint failed",
			"D1_ERROR: UNIQUE constraint failed",
		]);
		await recordExternalSend(
			wrapped,
			fixedClock(new Date("2031-04-03T00:00:00+09:00")),
			"anthropic:parser",
		);
		const logs = spy.mock.calls.map((c) => String(c[0]));
		spy.mockRestore();
		expect(calls()).toBe(1);
		expect(logs.some((l) => l.includes('"error_code":"D1_CONSTRAINT"'))).toBe(
			true,
		);
	});
});
