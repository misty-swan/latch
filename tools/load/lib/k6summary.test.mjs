import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { k6Row, readK6Metrics, renderChatTable } from "./k6summary.mjs";

const fixture = (name) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	);

describe("readK6Metrics", () => {
	it("(a)の結果からIntent保存とParserのp(95)を読む", () => {
		const m = readK6Metrics({ a: fixture("summary-a.json"), c: null });
		expect(m.intentSaveP95).toBeCloseTo(259.22, 2);
		expect(m.parseP95).toBeCloseTo(446.55, 2);
		expect(m.chatDeliveryP95).toBeNull();
		expect(m.chatConnect).toBeNull();
	});
	it("(c)の結果からチャットの到着のp(95)と接続の失敗(Rateのpasses=失敗した数)を読む", () => {
		const m = readK6Metrics({ a: null, c: fixture("summary-c.json") });
		expect(m.intentSaveP95).toBeNull();
		expect(m.parseP95).toBeNull();
		expect(m.chatDeliveryP95).toBeCloseTo(625.15, 2);
		expect(m.chatConnect).toEqual({ failed: 0, total: 10 });
	});
	it("ファイルが無い・指標が無い・値が数でないときはnull(NaNにしない)", () => {
		expect(readK6Metrics({ a: null, c: null })).toEqual({
			intentSaveP95: null,
			parseP95: null,
			chatDeliveryP95: null,
			chatConnect: null,
		});
		const m = readK6Metrics({
			a: { metrics: { "http_req_duration{name:parse}": { "p(95)": "x" } } },
			c: { metrics: { chat_connect_failed: { passes: 1 } } },
		});
		expect(m.parseP95).toBeNull();
		expect(m.chatConnect).toBeNull();
	});
});

describe("k6Row", () => {
	it("件数はk6のsummaryに無いので—、p95で合否を決める", () => {
		expect(k6Row("Intent保存", 500, 259)).toEqual({
			name: "Intent保存",
			targetMs: 500,
			total: "—",
			measured: "—",
			missing: "—",
			p95Ms: 259,
			pass: true,
		});
		expect(k6Row("x", 500, 501).pass).toBe(false);
		const none = k6Row("x", 500, null);
		expect(none.p95Ms).toBeNull();
		expect(none.pass).toBeNull();
	});
});

describe("renderChatTable", () => {
	it("参考値の表(目標なし)", () => {
		const out = renderChatTable({
			chatDeliveryP95: 625.15,
			chatConnect: { failed: 0, total: 10 },
		});
		expect(out).toContain("| チャット 送信→到着 p95 | 0.63秒 |");
		expect(out).toContain("| チャット 接続の失敗 | 0/10(0.00%) |");
	});
	it("値が無いときは計測なし", () => {
		const out = renderChatTable({ chatDeliveryP95: null, chatConnect: null });
		expect(out).toContain("| チャット 送信→到着 p95 | 計測なし |");
		expect(out).toContain("| チャット 接続の失敗 | 計測なし |");
	});
});
