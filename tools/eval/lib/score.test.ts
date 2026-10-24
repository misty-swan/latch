import { describe, expect, it } from "vitest";
import type {
	JevAxes,
	JevOutcome,
	ParserOutcome,
	ParserOutput,
} from "../../../apps/worker/src/llm/types";
import type { JevPair, ParserItem } from "./goldset";
import {
	type GateScores,
	type JevOrderScore,
	judge,
	type ParserScores,
	precisionAt,
	scoreJevOrder,
	scoreParser,
} from "./score";

const item = (id: string, expect: ParserItem["expect"]): ParserItem => ({
	id,
	raw_text: "週末にボードゲーム",
	now: "2026-11-02T10:00:00+09:00",
	tags: [],
	expect,
});

const output = (over: Partial<ParserOutput> = {}): ParserOutput => ({
	form: "occasion",
	topic: "ボードゲーム会",
	category: null,
	time: null,
	participants: { min: 2, max: 4 },
	budget: null,
	alcohol_involved: false,
	expires_at_options: [],
	warnings: [],
	...over,
});

const ok = (over: Partial<ParserOutput> = {}): ParserOutcome => ({
	ok: true,
	output: output(over),
});
const failed: ParserOutcome = { ok: false, kind: "timeout" };

describe("scoreParser", () => {
	it("各項目の一致率と、書かれていないキーを採点しないこと", () => {
		const items = [
			item("a", { form: "occasion", topic: "ボードゲーム" }),
			item("b", { form: "connection" }),
		];
		const s = scoreParser(items, [ok(), ok()]);
		expect(s.form).toEqual({ correct: 1, n: 2, rate: 0.5 });
		expect(s.topic).toEqual({ correct: 1, n: 1, rate: 1 });
		expect(s.category.n).toBe(0);
		expect(s.failures).toEqual([{ id: "b", field: "form" }]);
	});

	it("topic_anyはどれか1つが含まれれば一致・英字は大小を区別しない", () => {
		const items = [
			item("a", { topic_any: ["ボドゲ", "ボードゲーム"] }),
			item("b", { topic_any: ["rust"] }),
			item("c", { topic_any: ["映画"] }),
		];
		const s = scoreParser(items, [ok(), ok({ topic: "Rustもくもく会" }), ok()]);
		expect(s.topic).toEqual({ correct: 2, n: 3, rate: 2 / 3 });
		expect(s.failures).toEqual([{ id: "c", field: "topic" }]);
	});

	it("nullは「無いこと」を期待し、time_startは時刻の同一性で比べる", () => {
		const items = [
			item("a", { time_start: "2026-11-07T10:00:00Z", category: null }),
			item("b", { time_start: null, budget: null }),
			item("c", { time_start: null, budget: { min: 3000, max: 5000 } }),
		];
		const s = scoreParser(items, [
			ok({ time: { start: "2026-11-07T19:00:00+09:00", end: null } }),
			ok({ budget: { min: 1, max: 2 } }),
			ok({
				time: { start: "2026-11-07T19:00:00+09:00", end: null },
				budget: { min: 3000, max: 5000 },
			}),
		]);
		expect(s.time_start).toEqual({ correct: 2, n: 3, rate: 2 / 3 });
		expect(s.category).toEqual({ correct: 1, n: 1, rate: 1 });
		expect(s.budget).toEqual({ correct: 1, n: 2, rate: 0.5 });
	});

	it("participants・category・geo_warningを比べる", () => {
		const items = [
			item("a", {
				participants: { min: 2, max: 4 },
				category: "趣味・娯楽",
				geo_warning: true,
			}),
			item("b", { participants: { min: 3, max: 3 }, geo_warning: false }),
		];
		const s = scoreParser(items, [
			ok({
				category: "趣味・娯楽",
				warnings: [{ field: "geo", note: "地域を選んでください" }],
			}),
			ok({ warnings: [{ field: "geo", note: "x" }] }),
		]);
		expect(s.participants).toEqual({ correct: 1, n: 2, rate: 0.5 });
		expect(s.category).toEqual({ correct: 1, n: 1, rate: 1 });
		expect(s.geo_warning).toEqual({ correct: 1, n: 2, rate: 0.5 });
	});

	it("alcoholのrecall・precisionを採点した件で数える", () => {
		const items = [
			item("t1", { alcohol_involved: true }),
			item("t2", { alcohol_involved: true }),
			item("f1", { alcohol_involved: false }),
			item("f2", { alcohol_involved: false }),
			item("x", {}),
		];
		const s = scoreParser(items, [
			ok({ alcohol_involved: true }),
			ok({ alcohol_involved: false }),
			ok({ alcohol_involved: true }),
			ok({ alcohol_involved: false }),
			ok({ alcohol_involved: true }),
		]);
		expect(s.alcohol).toEqual({
			n: 4,
			tp: 1,
			fp: 1,
			fn: 1,
			recall: 0.5,
			precision: 0.5,
		});
	});

	it("呼び出しの失敗は採点するすべての項目で不一致として数え、失敗の内訳に残す", () => {
		const items = [
			item("a", { form: "occasion", alcohol_involved: true }),
			item("b", { form: "occasion", alcohol_involved: false }),
		];
		const s = scoreParser(items, [failed, ok()]);
		expect(s.form).toEqual({ correct: 1, n: 2, rate: 0.5 });
		expect(s.alcohol.fn).toBe(1);
		expect(s.alcohol.fp).toBe(0);
		expect(s.failedCalls).toBe(1);
		expect(s.failures).toEqual([{ id: "a", field: "call", kind: "timeout" }]);
	});

	it("件数と結果の数が違えば例外", () => {
		expect(() => scoreParser([item("a", {})], [])).toThrow();
	});
});

const axes = (over: Partial<JevAxes> = {}): JevAxes => ({
	would_a_accept_b: 0.5,
	would_b_accept_a: 0.5,
	purpose_fit: 0.5,
	mood_fit: 0.5,
	timing_fit: 0.5,
	social_fit: 0.5,
	latent_yes: 0.5,
	...over,
});
const jok = (over: Partial<JevAxes> = {}): JevOutcome => ({
	ok: true,
	axes: axes(over),
});
const jfail: JevOutcome = { ok: false, kind: "timeout" };

const allAxes = (v: number): JevAxes =>
	axes(Object.fromEntries(Object.keys(axes()).map((k) => [k, v])) as JevAxes);

const pair = (id: string, match: "yes" | "no" = "yes"): JevPair => {
	const f = {
		form: "connection" as const,
		topic: "ボードゲーム",
		softConstraints: [],
		negativeConstraints: [],
		participantsMin: 2,
		participantsMax: 2,
		participantsIncludesOwner: true,
		startsAt: null,
		endsAt: null,
		budgetMin: null,
		budgetMax: null,
	};
	return { id, a: f, b: f, match };
};

describe("scoreJevOrder", () => {
	it("acceptの2軸は入れ替えて比べ、他の軸は同じ軸どうしで比べる", () => {
		const s = scoreJevOrder(
			[pair("p1")],
			[jok({ would_a_accept_b: 0.9, would_b_accept_a: 0.1 })],
			[jok({ would_a_accept_b: 0.1, would_b_accept_a: 0.9 })],
		);
		expect(s.median).toBe(0);
		expect(s.n).toBe(7);
	});

	it("差の個数が偶数なら中央の2つの平均", () => {
		// 2組×7軸=14個の差: 1組目はmood_fitだけ差0.4(他の6軸は0)・2組目は全軸0.2
		const s = scoreJevOrder(
			[pair("p1"), pair("p2")],
			[jok({ mood_fit: 0.9 }), jok()],
			[jok({ mood_fit: 0.5 }), jok({ ...allAxes(0.7) })],
		);
		// 並べると [0×6, 0.2×7, 0.4] → 中央は7番目(0.2)と8番目(0.2)の平均
		expect(s.n).toBe(14);
		expect(s.median).toBeCloseTo(0.2, 10);
	});

	it("中央の2つが異なるときは平均を取る", () => {
		const s = scoreJevOrder(
			[pair("p1"), pair("p2")],
			[jok(), jok()],
			[jok({ ...allAxes(0.6) }), jok({ ...allAxes(0.8) })],
		);
		// [0.1×7, 0.3×7] → (0.1+0.3)/2
		expect(s.median).toBeCloseTo(0.2, 10);
	});

	it("失敗した組は除き、失敗の件数と割合を返す", () => {
		const s = scoreJevOrder(
			[pair("p1"), pair("p2")],
			[jok(), jfail],
			[jok(), jok()],
		);
		expect(s.n).toBe(7);
		expect(s.median).toBe(0);
		expect(s.failedCalls).toBe(1);
		expect(s.totalCalls).toBe(4);
		expect(s.failedPairs).toEqual(["p2"]);
	});

	it("全組が失敗なら中央値はnull", () => {
		const s = scoreJevOrder([pair("p1")], [jfail], [jfail]);
		expect(s.median).toBeNull();
		expect(s.n).toBe(0);
	});
});

describe("precisionAt", () => {
	it("min(a→b, b→a)×Cが閾値を超えた組のうち正解yesの割合", () => {
		const r = precisionAt(
			[
				pair("y1", "yes"),
				pair("n1", "no"),
				pair("y2", "yes"),
				pair("f", "yes"),
			],
			[
				jok({ would_a_accept_b: 0.9, would_b_accept_a: 0.8 }),
				jok({ would_a_accept_b: 0.9, would_b_accept_a: 0.7 }),
				jok({ would_a_accept_b: 0.9, would_b_accept_a: 0.6 }),
				jfail,
			],
			0.6,
		);
		// y2はちょうど0.6で閾値を超えない(Layer 5と同じ「>」)
		expect(r).toEqual({
			threshold: 0.6,
			precision: 0.5,
			predictedPositive: 2,
			truePositive: 1,
			n: 3,
			failedCalls: 1,
		});
	});

	it("閾値を超えた組が無ければprecisionはnull", () => {
		expect(precisionAt([pair("a")], [jok()], 0.6).precision).toBeNull();
	});
});

const rate = (correct: number, n: number) => ({
	correct,
	n,
	rate: n === 0 ? null : correct / n,
});

const passingParser = (): ParserScores => ({
	form: rate(9, 10),
	topic: rate(85, 100),
	category: rate(85, 100),
	time_start: rate(9, 10),
	participants: rate(8, 10),
	budget: rate(9, 10),
	geo_warning: rate(9, 10),
	alcohol: { n: 20, tp: 9, fp: 1, fn: 0, recall: 1, precision: 0.9 },
	failedCalls: 0,
	failures: [],
});

const jevScore = (median: number | null, failedCalls = 0): JevOrderScore => ({
	median,
	n: 7,
	failedCalls,
	totalCalls: 20,
	failedPairs: [],
});

const scores = (over: Partial<GateScores> = {}): GateScores => ({
	parser: passingParser(),
	jev: { primary: jevScore(0.3), fallback: jevScore(0.3) },
	...over,
});

describe("judge", () => {
	it("ちょうど基準値(90%・85%・80%・中央値0.3・失敗10%)は合格", () => {
		expect(
			judge(
				scores({
					jev: { primary: jevScore(0.3, 2), fallback: jevScore(0.3, 2) },
				}),
			),
		).toEqual({ passed: true, failures: [] });
	});

	it("基準を1件でも下回れば不合格で、項目を挙げる", () => {
		const p = passingParser();
		p.form = rate(89, 100);
		p.alcohol = { ...p.alcohol, recall: 0.9, fn: 1 };
		const r = judge(
			scores({
				parser: p,
				jev: { primary: jevScore(0.31), fallback: jevScore(0.1, 3) },
			}),
		);
		expect(r.passed).toBe(false);
		expect(r.failures).toHaveLength(4);
		expect(r.failures.join("\n")).toMatch(/form/);
		expect(r.failures.join("\n")).toMatch(/alcohol.*recall/);
		expect(r.failures.join("\n")).toMatch(/第一候補/);
		expect(r.failures.join("\n")).toMatch(/予備.*失敗/);
	});

	it("採点できる件が無い項目と、中央値が出せないJevは不合格", () => {
		const p = passingParser();
		p.budget = rate(0, 0);
		p.alcohol = { n: 0, tp: 0, fp: 0, fn: 0, recall: null, precision: null };
		const r = judge(
			scores({
				parser: p,
				jev: { primary: jevScore(null), fallback: jevScore(0) },
			}),
		);
		expect(r.passed).toBe(false);
		expect(r.failures).toHaveLength(4);
	});
});
