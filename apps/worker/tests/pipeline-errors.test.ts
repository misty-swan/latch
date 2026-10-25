import { describe, expect, it } from "vitest";
import { errorCodeOf } from "../src/pipeline/errors";

describe("errorCodeOf の分類(不具合の修正工程 第2回)", () => {
	it("Vectorizeの取得・upsertの失敗はコード付きで分類する", () => {
		expect(
			errorCodeOf(new Error("VECTOR_GET_ERROR (code = 40007): too many ids")),
		).toBe("VECTOR_GET_40007");
		expect(
			errorCodeOf(new Error("VECTOR_UPSERT_ERROR (code = 40012): x")),
		).toBe("VECTOR_UPSERT_40012");
	});

	it("Vectorizeの削除の失敗もコード付きで分類する(#44)", () => {
		expect(
			errorCodeOf(new Error("VECTOR_DELETE_ERROR (code = 40041): x")),
		).toBe("VECTOR_DELETE_40041");
	});

	it("causeのD1の過負荷とその他のD1の失敗を見分ける", () => {
		const overloaded = new Error("Failed query: delete from intents", {
			cause: new Error(
				"D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
			),
		});
		expect(errorCodeOf(overloaded)).toBe("D1_OVERLOADED");
		const other = new Error("Failed query: delete from intents", {
			cause: new Error("D1_ERROR: no such table"),
		});
		expect(errorCodeOf(other)).toBe("D1_ERROR");
	});

	it("D1の失敗を固定の語で細かく分類する(#29)", () => {
		const cases: [string, string][] = [
			["D1_ERROR: UNIQUE constraint failed: users.id", "D1_CONSTRAINT"],
			["D1_ERROR: FOREIGN KEY constraint failed", "D1_CONSTRAINT"],
			["D1_ERROR: database is busy", "D1_BUSY"],
			["D1_ERROR: database table is locked", "D1_BUSY"],
			["D1_ERROR: Network connection lost", "D1_RESET"],
			["D1_ERROR: connection reset", "D1_RESET"],
			["D1_ERROR: operation timed out", "D1_TIMEOUT"],
			["D1_ERROR: timeout", "D1_TIMEOUT"],
			["D1_ERROR: D1 DB is overloaded.", "D1_OVERLOADED"],
			["D1_ERROR: no such table", "D1_ERROR"],
		];
		for (const [message, code] of cases) {
			expect(
				errorCodeOf(new Error("Failed query", { cause: new Error(message) })),
			).toBe(code);
		}
	});

	it("causeは最大3段まで辿る", () => {
		const deep = new Error("a", {
			cause: new Error("b", {
				cause: new Error("c", { cause: new Error("D1_ERROR: x") }),
			}),
		});
		expect(errorCodeOf(deep)).toBe("D1_ERROR");
		const tooDeep = new Error("a", {
			cause: new Error("b", {
				cause: new Error("c", {
					cause: new Error("d", { cause: new Error("D1_ERROR: x") }),
				}),
			}),
		});
		expect(errorCodeOf(tooDeep, "FB")).toBe("FB");
	});

	it("Queuesの送信失敗・Workers AIの番号付きエラー・TypeErrorを分類する", () => {
		expect(errorCodeOf(new Error("Queue send failed: x"))).toBe(
			"QUEUE_SEND_FAILED",
		);
		expect(errorCodeOf(new Error("3040: Capacity temporarily exceeded"))).toBe(
			"AI_3040",
		);
		expect(errorCodeOf(new TypeError("x"))).toBe("TypeError");
	});

	it("従来の「CODE: 〜」形式と、判定できないもののfallback", () => {
		expect(errorCodeOf(new Error("EMBEDDING_TIMEOUT: x"))).toBe(
			"EMBEDDING_TIMEOUT",
		);
		expect(errorCodeOf("x", "FB")).toBe("FB");
		expect(errorCodeOf(new Error("boom"), "FB")).toBe("FB");
		expect(errorCodeOf(undefined)).toBe("INTERNAL");
	});
});
