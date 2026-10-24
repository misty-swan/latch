import { describe, expect, it } from "vitest";
import { buildReport } from "./report.mjs";

const empty = { judge: [], notify: [], retrieval: [] };

describe("buildReport", () => {
	it("Vectorizeの反映の行(件数・欠け・p50・p95・最大)を出し、合否は付けない", () => {
		const out = buildReport(
			"202610221200",
			{ a: null, c: null },
			{
				...empty,
				reflection: [
					{ status: "processed", reflect_ms: 1000 },
					{ status: "processed", reflect_ms: 3000 },
					{ status: "failed", reflect_ms: null },
				],
			},
		);
		expect(out).toContain(
			"| Vectorizeの反映 | 3 | 1 | 1.00秒 | 3.00秒 | 3.00秒 |",
		);
		expect(out).toContain(
			"欠けの内訳: skipped 0件・failed 1件・確認中(pending) 0件・その他 0件",
		);
		const none = buildReport("202610221200", { a: null, c: null }, empty);
		expect(none).toContain(
			"| Vectorizeの反映 | 0 | 0 | 計測なし | 計測なし | 計測なし |",
		);
	});
	it("結果のファイルもD1の行も無くても表を出す(計測なし・NaNを出さない)", () => {
		const out = buildReport("202610220442", { a: null, c: null }, empty);
		expect(out).toContain("| Intent保存 | 0.50秒 | — | — | — | 計測なし | — |");
		expect(out).toContain("| Parser | 3.00秒 |");
		expect(out).toContain(
			"| Candidate Retrieval | 1.00秒 | 0 | 0 | 0 | 計測なし | — |",
		);
		expect(out).toContain(
			"| 初期判定(相手が先に反映済み) | 10.00秒 | 0 | 0 | 0 | 計測なし | — |",
		);
		expect(out).toContain(
			"| 初期判定(同時・参考) | 0 | 0 | 計測なし | 計測なし | 計測なし |",
		);
		expect(out).toContain("| 通知 | 5.00秒 | 0 | 0 | 0 | 計測なし | — |");
		expect(out).toContain("| チャット 送信→到着 p95 | 計測なし |");
		expect(out).not.toContain("NaN");
		expect(out).not.toContain("undefined");
	});
	it("D1の行から初期判定・通知・Candidate Retrievalを集計し、イベント行の無いIntentの数を注記する", () => {
		const out = buildReport(
			"202610220442",
			{ a: null, c: null },
			{
				judge: [
					{
						auth_subject: "load-202610220442-b1",
						activated_at: 0,
						reflected_at: 500,
						push_attempted_at: 9000,
					},
					{
						auth_subject: "load-202610220442-b2",
						activated_at: 1000,
						reflected_at: 1500,
						push_attempted_at: 3000,
					},
					{
						auth_subject: "load-202610220442-b3",
						activated_at: 0,
						reflected_at: null,
						push_attempted_at: null,
					},
				],
				notify: [{ created_at: 0, push_attempted_at: 30 }],
				retrieval: [
					{ intent_id: "A", has_event: 1, retrieval_ms: 120 },
					{ intent_id: "B", has_event: 0, retrieval_ms: null },
				],
			},
		);
		expect(out).toContain(
			"| 初期判定(相手が先に反映済み) | 10.00秒 | 1 | 1 | 0 | 2.00秒 | 合格 |",
		);
		expect(out).toContain(
			"| 初期判定(同時・参考) | 2 | 1 | 9.00秒 | 9.00秒 | 9.00秒 |",
		);
		expect(out).toContain("| 通知 | 5.00秒 | 1 | 1 | 0 | 0.03秒 | 合格 |");
		expect(out).toContain(
			"| Candidate Retrieval | 1.00秒 | 2 | 1 | 1 | 0.12秒 | —(欠けあり) |",
		);
		expect(out).toContain("embedding_completedのイベント行が無い意思: 1件");
	});
	it("k6の結果を読み、起点と送信記録の注記を付ける", () => {
		const out = buildReport(
			"202610220437",
			{
				a: {
					metrics: {
						"http_req_duration{name:intent_save}": { "p(95)": 184.27 },
						"http_req_duration{name:parse}": { "p(95)": 376.1 },
					},
				},
				c: null,
			},
			empty,
		);
		expect(out).toContain(
			"| Intent保存 | 0.50秒 | — | — | — | 0.18秒 | 合格 |",
		);
		expect(out).toContain("| Parser | 3.00秒 | — | — | — | 0.38秒 | 合格 |");
		expect(out).toContain("保存のコミットよりわずかに後の時刻を起点にしている");
		expect(out).toContain("計測の時点のstagingの設定(LATCH_LLM_MODE)");
		expect(out).not.toContain("stubで動かした");
		expect(out).toContain("no_subscription");
	});
});

describe("buildReport: 確認中の内訳(#34)", () => {
	it("pendingの行を「確認中(pending)」の件数として出す", () => {
		const out = buildReport(
			"202610221200",
			{ a: null, c: null },
			{
				...empty,
				reflection: [
					{ status: "pending", reflect_ms: null },
					{ status: "pending", reflect_ms: null },
				],
			},
		);
		expect(out).toContain("確認中(pending) 2件・その他 0件");
	});
});
