import { describe, expect, it } from "vitest";
import {
	buildQueries,
	isReflected,
	judgeFromRows,
	judgePathBreakdown,
	notifyFromRows,
	reflectionBreakdown,
	reflectionFromRows,
	retrievalFromRows,
	splitJudgeRows,
} from "./queries.mjs";

describe("buildQueries", () => {
	it("12桁の数字でなければ例外(SQLへの差し込みを防ぐ)", () => {
		for (const bad of [
			"",
			"20261022044",
			"2026102204420",
			"20261022044a",
			"202610220442' OR 1=1 --",
			"%",
			undefined,
			202610220442,
		]) {
			expect(() => buildQueries(bad)).toThrow("実行の印");
		}
	});
	it("4つのSQLを返し、どれも実行の印の利用者((b)(d))で絞る", () => {
		const q = buildQueries("202610220442");
		expect(Object.keys(q).sort()).toEqual([
			"judge",
			"notify",
			"reflection",
			"retrieval",
		]);
		for (const sql of Object.values(q)) {
			expect(sql).toContain("u.auth_subject LIKE 'load-202610220442-%'");
			expect(sql).toContain("u.auth_subject LIKE 'load-202610220442-b%'");
			expect(sql).toContain("u.auth_subject LIKE 'load-202610220442-d%'");
			expect(sql).toMatch(/^SELECT /);
			expect(sql).not.toContain(";");
		}
	});
	it("シナリオを指定すると(b)か(d)の利用者だけに絞る。不正な値は例外(#33)", () => {
		for (const sql of Object.values(buildQueries("202610220442", "d"))) {
			expect(sql).toContain("u.auth_subject LIKE 'load-202610220442-d%'");
			expect(sql).not.toContain("load-202610220442-b%");
		}
		expect(buildQueries("202610220442", "b").notify).not.toContain("-d%");
		expect(() => buildQueries("202610220442", "x")).toThrow("シナリオ");
		const all = buildQueries("202610220442");
		for (const sql of Object.values(all)) {
			expect(sql).toContain("load-202610220442-b%");
			expect(sql).toContain("load-202610220442-d%");
		}
		const d = buildQueries("202610220442", "d").notify;
		expect(d).toContain("load-202610220442-d%");
		expect(d).not.toContain("-b%");
	});
	it("初期判定: intent_createdの作成時刻と、そのIntentを含むLATCHの提案の通知の最小のpush_attempted_at", () => {
		const { judge } = buildQueries("202610220442");
		expect(judge).toContain("event_type = 'intent_created'");
		expect(judge).toContain("json_each(l.intent_ids)");
		expect(judge).toContain("n.type = 'proposal'");
		expect(judge).toContain("n.user_id = i.user_id");
		expect(judge).toContain("min(n.push_attempted_at)");
	});
	it("通知: 提案の通知のcreated_atとpush_attempted_at", () => {
		const { notify } = buildQueries("202610220442");
		expect(notify).toContain("n.type = 'proposal'");
		expect(notify).toContain("n.created_at");
		expect(notify).toContain("n.push_attempted_at");
	});
	it("Candidate Retrieval: embedding_completedのpayloadのretrieval_ms", () => {
		const { retrieval } = buildQueries("202610220442");
		expect(retrieval).toContain("event_type = 'embedding_completed'");
		expect(retrieval).toContain("json_extract(me.payload, '$.retrieval_ms')");
	});
});

describe("judgeFromRows", () => {
	it("push_attempted_at−activated_at、提案なし・起点なしはnull(欠け)", () => {
		expect(
			judgeFromRows([
				{ intent_id: "A", activated_at: 1000, push_attempted_at: 3500 },
				{ intent_id: "B", activated_at: 1000, push_attempted_at: null },
				{ intent_id: "C", activated_at: null, push_attempted_at: 3500 },
			]),
		).toEqual([2500, null, null]);
	});
	it("行が無ければ空", () => expect(judgeFromRows([])).toEqual([]));
});

describe("notifyFromRows", () => {
	it("push_attempted_at−created_at、未送信はnull", () => {
		expect(
			notifyFromRows([
				{ created_at: 10, push_attempted_at: 40 },
				{ created_at: 10, push_attempted_at: null },
			]),
		).toEqual([30, null]);
	});
});

describe("retrievalFromRows", () => {
	it("retrieval_msを値に、イベントが無いIntentを数える(数でない値も欠け)", () => {
		expect(
			retrievalFromRows([
				{ intent_id: "A", has_event: 1, retrieval_ms: 42 },
				{ intent_id: "B", has_event: 0, retrieval_ms: null },
				{ intent_id: "C", has_event: 1, retrieval_ms: null },
				{ intent_id: "D", has_event: 1, retrieval_ms: "x" },
			]),
		).toEqual({ durations: [42, null, null, null], withoutEvent: 1 });
	});
});

describe("反映時間", () => {
	it("SQL: vector_reflectionの行のreflect_msとstatusを(b)(d)の利用者で絞って取る", () => {
		const { reflection } = buildQueries("202610221200");
		expect(reflection).toContain("event_type = 'vector_reflection'");
		expect(reflection).toContain("json_extract(me.payload, '$.reflect_ms')");
		expect(reflection).toContain("me.status");
		expect(reflection).toContain("u.auth_subject LIKE 'load-202610221200-b%'");
		expect(reflection).toContain("u.auth_subject LIKE 'load-202610221200-d%'");
	});
	it("processed以外・値の無い行はnull(欠け)", () => {
		expect(
			reflectionFromRows([
				{ status: "processed", reflect_ms: 1200 },
				{ status: "failed", reflect_ms: null },
				{ status: "processed", reflect_ms: null },
				{ status: "failed", reflect_ms: 5 },
			]),
		).toEqual([1200, null, null, null]);
	});
});

describe("初期判定の振り分け", () => {
	it("SQL: 利用者のsubjectと、その意思の反映確認(processed)の最小のprocessed_atを取る", () => {
		const { judge } = buildQueries("202610221200");
		expect(judge).toContain("u.auth_subject AS auth_subject");
		expect(judge).toContain("event_type = 'vector_reflection'");
		expect(judge).toContain("me.status = 'processed'");
		expect(judge).toContain("min(me.processed_at)");
		expect(judge).toContain("AS reflected_at");
	});
	const row = (n, activated, reflected, pushed, tag = "b") => ({
		auth_subject: `load-202610221200-${tag}${n}`,
		activated_at: activated,
		reflected_at: reflected,
		push_attempted_at: pushed,
	});
	it("相手の反映が自分の保存より前なら相手が先に反映済み、後なら同時", () => {
		const out = splitJudgeRows([
			// 組1(連番1と2): 1が先に保存・2は1の反映の後に保存
			row(1, 1000, 1800, 6000),
			row(2, 2000, 2900, 4500),
			// 組2(連番3と4): 4の保存の時点で3は未反映
			row(3, 1000, 5000, 7000),
			row(4, 1500, 5200, 8000),
		]);
		expect(out.preReflected).toEqual([2500]);
		expect(out.simultaneous).toEqual([5000, 6000, 6500]);
	});
	it("境界(同時刻)・相手の行が無い・相手が未反映は同時", () => {
		const out = splitJudgeRows([
			row(1, 1000, 2000, 5000),
			row(2, 2000, 3000, 5000), // 相手の反映2000=自分の保存2000は同時
			row(5, 1000, 1200, 3000), // 相手(連番6)の行が無い
			row(7, 1000, null, 3000),
			row(8, 9000, 9500, 12000), // 相手(7)は未反映
		]);
		expect(out.preReflected).toEqual([]);
		expect(out.simultaneous).toEqual([4000, 3000, 2000, 2000, 3000]);
	});
	it("(d)の組は反映の時刻によらず同時。提案なしは欠け(null)として振り分けられる", () => {
		const out = splitJudgeRows([
			row(1, 1000, 1100, 3000, "d"),
			row(2, 2000, 2100, null, "d"),
			row(3, 1000, 1100, 6000),
			row(4, 5000, 5100, null),
		]);
		expect(out.preReflected).toEqual([null]);
		expect(out.simultaneous).toEqual([2000, null, 5000]);
	});
	it("subjectの形が想定外の行は同時に入れる", () => {
		expect(
			splitJudgeRows([
				{
					auth_subject: "x",
					activated_at: 0,
					reflected_at: 1,
					push_attempted_at: 5,
				},
			]),
		).toEqual({ preReflected: [], simultaneous: [5] });
	});
});

describe("反映確認のskipped(payload.skipped)", () => {
	it("judgeのreflected_atと反映のSQLは、payload.skippedを見てnot_evaluatedだけを反映済みとする", () => {
		const { judge, reflection } = buildQueries("202610221200");
		expect(judge).toContain(
			"AND (json_extract(me.payload, '$.skipped') IS NULL OR json_extract(me.payload, '$.skipped') = 'not_evaluated')",
		);
		expect(reflection).toContain(
			"json_extract(me.payload, '$.skipped') AS skipped",
		);
	});
	it("内訳: processedでskipped(not_found・stale_version・inactive)の行をskippedに数え、not_evaluated(値あり)は反映済み", () => {
		expect(
			reflectionBreakdown([
				{ status: "processed", reflect_ms: 5, skipped: "not_evaluated" },
				{ status: "processed", reflect_ms: null, skipped: "not_found" },
				{ status: "processed", reflect_ms: null, skipped: "stale_version" },
				{ status: "processed", reflect_ms: null, skipped: "inactive" },
				{ status: "processed", reflect_ms: null, skipped: null },
			]),
		).toEqual({ skipped: 3, failed: 0, pending: 0, other: 1 });
	});
	it("reflectionBreakdown: pendingは確認中として数え、otherに入れない(#34)", () => {
		expect(
			reflectionBreakdown([
				{ status: "pending", reflect_ms: null },
				{ status: "pending", reflect_ms: null },
				{ status: "failed", reflect_ms: null },
				{ status: "dead", reflect_ms: null },
			]),
		).toEqual({ skipped: 0, failed: 1, pending: 2, other: 1 });
	});
	it("isReflected: processedでもskipped(not_evaluated以外)なら反映済みとしない", () => {
		const item = (skipped) => ({
			event_type: "vector_reflection",
			status: "processed",
			payload: skipped === undefined ? {} : { skipped, reflect_ms: 1 },
		});
		expect(isReflected([item("not_found")])).toBe(false);
		expect(isReflected([item("stale_version"), item("inactive")])).toBe(false);
		expect(isReflected([item("not_evaluated")])).toBe(true);
		expect(isReflected([item(undefined)])).toBe(true);
	});
});

describe("反映の欠けの内訳", () => {
	it("processedで値の無い行はその他、failedとskippedを分けて数える", () => {
		expect(
			reflectionBreakdown([
				{ status: "processed", reflect_ms: 1 },
				{ status: "failed", reflect_ms: null },
				{ status: "failed", reflect_ms: null },
				{ status: "processed", reflect_ms: null, skipped: "not_found" },
				{ status: "processed", reflect_ms: null },
			]),
		).toEqual({ skipped: 1, failed: 2, pending: 0, other: 1 });
	});
});

describe("isReflected(GET /v1/dev/match-eventsの項目)", () => {
	it("vector_reflectionのprocessedがあればtrue、無い・pending・failedはfalse", () => {
		const item = (event_type, status) => ({ event_type, status });
		expect(
			isReflected([
				item("intent_created", "processed"),
				item("vector_reflection", "processed"),
			]),
		).toBe(true);
		expect(
			isReflected([
				item("intent_created", "processed"),
				item("vector_reflection", "pending"),
				item("vector_reflection", "failed"),
			]),
		).toBe(false);
		expect(isReflected([])).toBe(false);
		expect(isReflected(undefined)).toBe(false);
	});
});

describe("初期判定の行の経路の内訳(応答の後の処理/キュー)", () => {
	it("SQL: 有効化の行(intent_created)のpayload.pathをorigin_pathとして取る", () => {
		const { judge } = buildQueries("202610220442");
		expect(judge).toContain("json_extract(me.payload, '$.path')");
		expect(judge).toContain("AS origin_path");
	});
	it("inline・queueを数え、それ以外(印なし・想定外の値)は不明に数える", () => {
		expect(
			judgePathBreakdown([
				{ origin_path: "inline" },
				{ origin_path: "inline" },
				{ origin_path: "queue" },
				{ origin_path: null },
				{ origin_path: "other" },
				{},
			]),
		).toEqual({ inline: 2, queue: 1, unknown: 3 });
		expect(judgePathBreakdown([])).toEqual({ inline: 0, queue: 0, unknown: 0 });
	});
});
