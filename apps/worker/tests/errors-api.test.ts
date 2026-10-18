/**
 * 未捕捉例外時のエラー応答の統合試験(docs/05 §3.1: エラー応答は1形状のみ)。
 * index.tsと同じくapp.onErrorにinternalOnErrorを登録した最小のHonoアプリを
 * app.request()で叩き、例外を投げるルートがerrorJson形状の500 INTERNALになることを
 * 検証する。実際のアプリには到達可能なthrow経路が無いため、専用アプリでの検証とする
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/auth/middleware";
import { internalOnError } from "../src/http/errors";

/** index.tsと同一の登録(onError)を持つ最小アプリ。ルートは必ず例外を投げる */
const throwingApp = new Hono<AppEnv>();
throwingApp.onError(internalOnError);
throwingApp.get("/boom", () => {
	throw new Error("内部エラーの生メッセージ(応答に現れてはならない)");
});

describe("app.onError(internalOnError)(docs/05 §3.1: エラー応答は1形状のみ)", () => {
	it("未捕捉例外は500 INTERNAL・errorJson形状・content-typeはJSON", async () => {
		const res = await throwingApp.request("/boom");
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			error: {
				code: string;
				message: string;
				details: Record<string, unknown>;
			};
		};
		expect(body.error.code).toBe("INTERNAL");
		expect(typeof body.error.message).toBe("string");
		expect(body.error.details).toEqual({});
	});

	it("例外の生メッセージ・スタックは応答本文に現れない", async () => {
		const res = await throwingApp.request("/boom");
		const text = await res.text();
		expect(text).not.toContain("内部エラーの生メッセージ");
		// Hono既定の「Internal Server Error」プレーンテキストではない(JSON 1形状)
		expect(text).not.toBe("Internal Server Error");
	});
});
