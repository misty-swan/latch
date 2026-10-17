import { describe, expect, it, vi } from "vitest";
import { createLogger, LOG_FIELD_ALLOWLIST, type LogFields } from "./logger";

/** sinkに流れた行を1行ずつ集めるテスト用sink */
const captureSink = (): { lines: string[]; sink: (line: string) => void } => {
	const lines: string[] = [];
	return {
		lines,
		sink: (line) => {
			lines.push(line);
		},
	};
};

/** sinkへ1回の呼び出しで1行だけ流れたことを確認してからJSONとして解析する */
const parseSingleLine = (lines: string[]): Record<string, unknown> => {
	expect(lines).toHaveLength(1);
	const line = lines[0];
	expect(line).toBeDefined();
	expect(line).not.toContain("\n");
	return JSON.parse(line ?? "行が存在しない") as Record<string, unknown>;
};

describe("createLogger(08 §6: 許可リスト方式の構造化ログ)", () => {
	it("info()はsinkへ1行JSONを出力し・level・event・許可フィールドを含む", () => {
		const { lines, sink } = captureSink();
		const logger = createLogger(sink);
		logger.info("intent_saved", {
			intent_id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
			status: "draft",
			count: 1,
		});
		const parsed = parseSingleLine(lines);
		expect(parsed.level).toBe("info");
		expect(parsed.event).toBe("intent_saved");
		expect(parsed.intent_id).toBe("01HXXXXXXXXXXXXXXXXXXXXXXX");
		expect(parsed.status).toBe("draft");
		expect(parsed.count).toBe(1);
	});

	it("許可リスト外のキーは黙って破棄される(raw_text・user_id・座標)", () => {
		const { lines, sink } = captureSink();
		const logger = createLogger(sink);
		// 呼び出し側が禁じフィールドを紛れ込ませる経路(型では防げない)を模倣する
		const smuggled = {
			raw_text: "内緒",
			user_id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
			lat: 35.6,
		} as unknown as LogFields;
		logger.warn("searched", smuggled);
		const parsed = parseSingleLine(lines);
		expect(parsed).not.toHaveProperty("raw_text");
		expect(parsed).not.toHaveProperty("user_id");
		expect(parsed).not.toHaveProperty("lat");
		expect(parsed.event).toBe("searched");
	});

	it("undefined・nullの値を持つ許可フィールドはキーごと出力しない", () => {
		const { lines, sink } = captureSink();
		const logger = createLogger(sink);
		const sparse = {
			count: undefined,
			latency: null,
			status: "matched",
		} as unknown as LogFields;
		logger.info("proposal_created", sparse);
		const parsed = parseSingleLine(lines);
		expect(parsed).not.toHaveProperty("count");
		expect(parsed).not.toHaveProperty("latency");
		expect(parsed.status).toBe("matched");
	});

	it("fields省略時はlevel・eventのみの1行JSON", () => {
		const { lines, sink } = captureSink();
		createLogger(sink).error("unexpected_failure");
		const parsed = parseSingleLine(lines);
		expect(Object.keys(parsed).sort()).toEqual(["event", "level"]);
	});

	it("許可リストは08 §6の8フィールドと完全一致する", () => {
		expect([...LOG_FIELD_ALLOWLIST]).toEqual([
			"intent_id",
			"latch_id",
			"status",
			"version",
			"error_code",
			"layer",
			"count",
			"latency",
		]);
	});

	it("8フィールドすべてが実際に出力できる", () => {
		const { lines, sink } = captureSink();
		const logger = createLogger(sink);
		logger.debug("layer2_retrieval", {
			intent_id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
			latch_id: "01HYYYYYYYYYYYYYYYYYYYYYY",
			status: "matched",
			version: 1,
			error_code: "none",
			layer: "layer2",
			count: 12,
			latency: 42,
		});
		const parsed = parseSingleLine(lines);
		const fieldKeys = Object.keys(parsed)
			.filter((key) => key !== "level" && key !== "event")
			.sort();
		expect(fieldKeys).toEqual([...LOG_FIELD_ALLOWLIST].sort());
		expect(parsed.layer).toBe("layer2");
		expect(parsed.latency).toBe(42);
	});

	it("debug・info・warn・errorの4レベルが機能する", () => {
		const { lines, sink } = captureSink();
		const logger = createLogger(sink);
		logger.debug("debug_event", {});
		logger.info("info_event");
		logger.warn("warn_event");
		logger.error("error_event");
		expect(lines).toHaveLength(4);
		const levels = lines.map(
			(line) => (JSON.parse(line) as Record<string, unknown>).level,
		);
		expect(levels).toEqual(["debug", "info", "warn", "error"]);
	});

	it("sink省略時の既定はconsole.log", () => {
		const logged = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			createLogger().info("intent_saved", { status: "draft" });
			expect(logged).toHaveBeenCalledTimes(1);
			const line = logged.mock.calls[0]?.[0];
			expect(typeof line).toBe("string");
			expect(JSON.parse(line as string)).toMatchObject({
				level: "info",
				event: "intent_saved",
				status: "draft",
			});
		} finally {
			logged.mockRestore();
		}
	});
});
