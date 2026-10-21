/**
 * 汎用文の本文とTTLの単体試験(F7b設計 §5.4)。
 */

import { describe, expect, it } from "vitest";
import { PUSH_BODIES, pushPayload, pushTtlSeconds } from "./payload";

const now = new Date("2026-10-21T00:00:00Z");
const inSec = (sec: number) => new Date(now.getTime() + sec * 1000);

describe("pushPayload", () => {
	it("本文は固定の汎用文2つ", () => {
		expect(PUSH_BODIES.proposal).toBe(
			"提案が届いています。詳細はアプリでご確認ください。",
		);
		expect(PUSH_BODIES.matched).toBe(
			"つながりが成立しました。詳細はアプリでご確認ください。",
		);
	});

	it("キーはtypeとbodyだけ", () => {
		const p = JSON.parse(pushPayload("proposal"));
		expect(Object.keys(p).sort()).toEqual(["body", "type"]);
		expect(p).toEqual({ type: "proposal", body: PUSH_BODIES.proposal });
	});
});

describe("pushTtlSeconds", () => {
	it("proposalは回答期限までの秒を60〜86,400に収める", () => {
		expect(pushTtlSeconds("proposal", now, inSec(30))).toBe(60);
		expect(pushTtlSeconds("proposal", now, inSec(2 * 3600))).toBe(7200);
		expect(pushTtlSeconds("proposal", now, inSec(48 * 3600))).toBe(86_400);
	});
	it("matchedは86,400", () => {
		expect(pushTtlSeconds("matched", now, null)).toBe(86_400);
	});
	it("proposalで期限がnullなら86,400", () => {
		expect(pushTtlSeconds("proposal", now, null)).toBe(86_400);
	});
});
