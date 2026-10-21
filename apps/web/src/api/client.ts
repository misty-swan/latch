/**
 * APIクライアント(docs/04 §3.2・05 §3.1)。
 * - 同一オリジンの /v1 配下へfetchし・アクセストークンをBearerで自動付与する
 * - 401(TOKEN_EXPIRED/UNAUTHORIZED)はauthSession.refresh()を1回試みて同一リクエストを再試行する
 * - リフレッシュ失敗・リフレッシュトークン不在・再試行でも401のときは
 *   セッションを破棄して/welcomeへ遷移する(再試行は1回のみ=無限ループの防止)
 * - エラー応答はdocs/05 §3.1の共通形状をApiErrorとして投げる
 */

import { type ErrorCode, errorCodeSchema } from "@latch/shared";
import { authSession } from "../auth/session";
import { PATHS } from "../routes/paths";

/** APIエラー(docs/05 §3.1の共通形状) */
export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly details: Record<string, unknown>;

	constructor(
		code: ErrorCode,
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.details = details;
	}
}

/** apiFetchのオプション。jsonを指定するとJSONボディとして送る */
export type ApiFetchInit = RequestInit & { json?: unknown };

const API_ROOT = "/v1";
/** リフレッシュを試みるエラーコード(docs/05 §3.1の401系) */
const AUTH_REFRESH_CODES: ReadonlySet<string> = new Set([
	"TOKEN_EXPIRED",
	"UNAUTHORIZED",
]);

const isAuthError = (error: ApiError): boolean =>
	AUTH_REFRESH_CODES.has(error.code);

/** エラー応答をdocs/05 §3.1の形状へ正規化する(未知の形状はINTERNALへ倒す) */
const toApiError = (status: number, body: unknown): ApiError => {
	const raw = (body as { error?: unknown } | null)?.error;
	if (typeof raw === "object" && raw !== null) {
		const { code, message, details } = raw as {
			code?: unknown;
			message?: unknown;
			details?: unknown;
		};
		const parsedCode = errorCodeSchema.safeParse(code);
		if (parsedCode.success) {
			return new ApiError(
				parsedCode.data,
				typeof message === "string" ? message : `HTTP ${status}`,
				typeof details === "object" && details !== null
					? (details as Record<string, unknown>)
					: {},
			);
		}
	}
	return new ApiError("INTERNAL", `HTTP ${status}`, {});
};

const readError = async (response: Response): Promise<ApiError> => {
	try {
		return toApiError(response.status, await response.json());
	} catch {
		return new ApiError("INTERNAL", `HTTP ${response.status}`, {});
	}
};

const readSuccess = async <T>(response: Response): Promise<T> => {
	if (response.status === 204) {
		return undefined as T;
	}
	// 本文なしの2xx(POST /v1/users/{id}/blockの201/200)は値なしとして返す
	const text = await response.text();
	return (text === "" ? undefined : JSON.parse(text)) as T;
};

/** 1リクエストを送る(Bearer・JSONボディの組み立て) */
const send = async (path: string, init: ApiFetchInit): Promise<Response> => {
	const { json, headers: rawHeaders, ...rest } = init;
	const headers = new Headers(rawHeaders);
	if (json !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const token = authSession.accessToken;
	if (token !== null) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return fetch(`${API_ROOT}${path}`, {
		...rest,
		headers,
		body: json !== undefined ? JSON.stringify(json) : rest.body,
	});
};

/** セッションを破棄してwelcomeへ戻す(リフレッシュ不能な401の共通後処理) */
const abandonSession = (): void => {
	authSession.clear();
	window.location.assign(PATHS.welcome);
};

export const apiFetch = async <T>(
	path: string,
	init: ApiFetchInit = {},
): Promise<T> => {
	let response = await send(path, init);
	if (response.ok) {
		return readSuccess<T>(response);
	}
	let error = await readError(response);
	if (response.status === 401 && isAuthError(error)) {
		// リフレッシュは1回だけ。再試行後の401では再リフレッシュしない
		if (await authSession.refresh()) {
			response = await send(path, init);
			if (response.ok) {
				return readSuccess<T>(response);
			}
			error = await readError(response);
			if (!(response.status === 401 && isAuthError(error))) {
				throw error;
			}
		}
		abandonSession();
	}
	throw error;
};
