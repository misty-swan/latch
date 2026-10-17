import { describe, expect, it } from "vitest";
import { categorySchema, intentFormSchema } from "./schema";

describe("intentFormSchema", () => {
	it("connection を受理する", () => {
		expect(intentFormSchema.parse("connection")).toBe("connection");
	});

	it("未定義のフォーム friendship を拒否する", () => {
		expect(intentFormSchema.safeParse("friendship").success).toBe(false);
	});
});

describe("categorySchema", () => {
	it("「その他」を受理する", () => {
		expect(categorySchema.safeParse("その他").success).toBe(true);
	});

	it("未定義のカテゴリ「旅行」を拒否する(「旅行・アウトドア」とは部分一致しない)", () => {
		expect(categorySchema.safeParse("旅行").success).toBe(false);
	});
});
