/**
 * エラー応答の共通形状(docs/05 §3.1)。
 * 全APIのエラーは {error: {code, message(日本語), details}} の1形状のみ。
 * ルートでは `const r = errorJson(...); return c.json(r.body, r.status);` の形で使う
 */

import { ERROR_HTTP_STATUS, type ErrorCode } from "@latch/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

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
