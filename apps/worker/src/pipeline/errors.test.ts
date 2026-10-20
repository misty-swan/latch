import { describe, expect, it } from "vitest";
import { errorCodeOf } from "./errors";

describe("errorCodeOf", () => {
	it("「CODE: 〜」形式のErrorは接頭辞のコードを返す", () => {
		expect(errorCodeOf(new Error("EMBEDDING_FAILED: x"))).toBe(
			"EMBEDDING_FAILED",
		);
	});

	it("Error以外・コード形式でないメッセージはfallback(既定INTERNAL)", () => {
		expect(errorCodeOf("x")).toBe("INTERNAL");
		expect(errorCodeOf(new Error("boom"), "EMBEDDING_FAILED")).toBe(
			"EMBEDDING_FAILED",
		);
	});
});
