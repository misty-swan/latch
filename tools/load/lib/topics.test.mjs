import { describe, expect, it } from "vitest";
import { TOPICS } from "./topics.js";

/** stubのParserの語(apps/worker/src/llm/stub/parser.ts)を写したもの */
const TIME_WORD = /(\d{1,2})時(半)?/;
const DATE_WORD = /(今日|明日|明後日|\d{1,2}日|(日|月|火|水|木|金|土)曜)/;
const ALCOHOL =
	/飲み|飲酒|酒|ビール|ワイン|焼酎|サワー|ハイボール|カクテル|バー|居酒屋/;

describe("TOPICS", () => {
	it("60件以上で重複が無い", () => {
		expect(TOPICS.length).toBeGreaterThanOrEqual(60);
		expect(new Set(TOPICS).size).toBe(TOPICS.length);
	});
	it.each(TOPICS)(
		"%s はtopicに使える(40字以内・句点なし・つながりとして読まれる)",
		(t) => {
			expect(t.length).toBeGreaterThan(0);
			expect(t.length).toBeLessThanOrEqual(40);
			expect(t).not.toMatch(/[。\n]/);
			expect(t).not.toMatch(TIME_WORD);
			expect(t).not.toMatch(DATE_WORD);
			expect(t).not.toMatch(ALCOHOL);
			expect(t).not.toMatch(/\d人|\d円/);
		},
	);
});
