import { describe, expect, it } from "vitest";
import {
	buildQueries,
	judgeFromRows,
	notifyFromRows,
	reflectionFromRows,
	retrievalFromRows,
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
