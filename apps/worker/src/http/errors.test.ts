/**
 * エラー応答共通形状の単体試験(docs/05 §3.1)。
 * バインディングに依存しない純粋な単体試験のためcloudflare:testは使わない(jwt.test.tsと同じ方針)。
 */

import { describe, expect, it } from "vitest";
import { errorJson } from "./errors";

describe("errorJson(docs/05 §3.1: エラーは次の形状のみ)", () => {
	it("UNDER_AGEはdocs/05 §3.1対応のstatus 422と形状{error:{code,message,details}}を返す", () => {
		const r = errorJson("UNDER_AGE", "18歳未満は利用できません");
		expect(r.status).toBe(422);
		expect(r.body).toEqual({
			error: {
				code: "UNDER_AGE",
				message: "18歳未満は利用できません",
				details: {},
			},
		});
	});

	it("TOKEN_EXPIREDはstatus 401を返す", () => {
		const r = errorJson(
			"TOKEN_EXPIRED",
			"アクセストークンの有効期限が切れています",
		);
		expect(r.status).toBe(401);
		expect(r.body.error.code).toBe("TOKEN_EXPIRED");
	});

	it("details省略時は既定の空オブジェクト{}", () => {
		const r = errorJson("UNAUTHORIZED", "認証が必要です");
		expect(r.body.error.details).toEqual({});
	});

	it("detailsを渡すと応答のdetailsに反映される", () => {
		const r = errorJson("VALIDATION_FAILED", "入力が不正です", {
			field: "display_name",
		});
		expect(r.body.error.details).toEqual({ field: "display_name" });
	});
});
