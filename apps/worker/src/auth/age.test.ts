/**
 * 年齢計算の単体試験(docs/05 §3.2: POST /v1/usersの18歳検証)。
 * ageAtYearsはDate+文字列のみを扱う純粋関数のためcloudflare:testは使わない
 * (jwt.test.tsと同じ方針)。nowはJSTの暦日が固定となるよう正午で作る
 * (JST正午=UTC3時。時刻端の曖昧さを排除する)
 */

import { describe, expect, it } from "vitest";
import { ageAtYears } from "./age";

/** JSTの暦日(年・月・日)の正午にあたるDateを作る(+9時間の固定オフセットでJST正午=UTC3時) */
const jstNoon = (year: number, month: number, day: number): Date =>
	new Date(Date.UTC(year, month - 1, day, 3, 0, 0));

describe("ageAtYears(docs/05 §3.2: 18歳検証・JSTカレンダー比較)", () => {
	it("18歳の誕生日当日は18(当日から登録可)", () => {
		expect(ageAtYears(jstNoon(2026, 10, 18), "2008-10-18")).toBe(18);
	});

	it("18歳の誕生日前日は17(翌日が18歳になる・前日はUNDER_AGE)", () => {
		expect(ageAtYears(jstNoon(2026, 10, 18), "2008-10-19")).toBe(17);
	});

	it("2/29生まれは平年の2/28時点で17(まだ加齢しない)", () => {
		expect(ageAtYears(jstNoon(2026, 2, 28), "2008-02-29")).toBe(17);
	});

	it("2/29生まれは平年の3/1到達で18(3/1に加齢する)", () => {
		expect(ageAtYears(jstNoon(2026, 3, 1), "2008-02-29")).toBe(18);
	});

	it("2/29生まれはうるう年の2/29当日に加齢する", () => {
		expect(ageAtYears(jstNoon(2028, 2, 29), "2008-02-29")).toBe(20);
	});

	it("年初生まれ(2000-01-01)は2026-10-18時点で26", () => {
		expect(ageAtYears(jstNoon(2026, 10, 18), "2000-01-01")).toBe(26);
	});

	it("UTC時刻がまだ前日でもJST基準の暦日で判定する(固定オフセット計算)", () => {
		// 2026-10-17T15:30Z = JST 2026-10-18 00:30 → JSTでは誕生日当日
		expect(
			ageAtYears(new Date(Date.UTC(2026, 9, 17, 15, 30)), "2008-10-18"),
		).toBe(18);
	});
});
