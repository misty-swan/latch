/**
 * エラー応答の共通形状(docs/05 §3.1)。
 * 全APIのエラーは {error: {code, message(日本語), details}} の1形状のみ。
 * ルートでは `const r = errorJson(...); return c.json(r.body, r.status);` の形で使う
 */

import { ERROR_HTTP_STATUS, type ErrorCode } from "@latch/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../auth/middleware";
import { createLogger } from "../logging/logger";

/** エラー応答1件。statusはHonoのc.jsonにそのまま渡せる数値(numberの部分型) */
export interface ErrorResult {
	status: ContentfulStatusCode;
	body: {
		error: {
			code: string;
			message: string;
			details: Record<string, unknown>;
		};
	};
}

/**
 * エラー応答を組み立てる(docs/05 §3.1)。details省略時は空オブジェクト{}。
 * statusはdocs/05 §3.1のエラーコード対応表(ERROR_HTTP_STATUS・@latch/shared)から取る
 */
export const errorJson = (
	code: ErrorCode,
	message: string,
	details: Record<string, unknown> = {},
): ErrorResult => {
	// ERROR_HTTP_STATUSの値はすべて本体(contentful)なステータス(400/401/403/404/409/422/429/500)である
	const status = ERROR_HTTP_STATUS[code] as ContentfulStatusCode;
	return {
		status,
		body: { error: { code, message, details } },
	};
};

/** 構造化ロガー(許可フィールドのみ・docs/08 §6)。例外の生メッセージ・スタックは出力しない */
const logger = createLogger();

/**
 * 未捕捉例外の最終ハンドラ(index.tsのapp.onErrorに登録する)。
 * どこでも捕捉されなかった例外をdocs/05 §3.1の1形状(errorJson)の500 INTERNALに倒し、
 * Hono既定のプレーンテキスト応答が起こらないようにする。例外の生メッセージ・スタックは
 * 応答にも構造化ログにも現れない(許可フィールド外・docs/08 §6)
 */
export const internalOnError = (_err: Error, c: Context<AppEnv>): Response => {
	logger.error("api.internal_error", { error_code: "INTERNAL" });
	const r = errorJson("INTERNAL", "予期しないエラーが発生しました");
	return c.json(r.body, r.status);
};
