/**
 * dev専用ルート(F2'計画Task 2: POST /v1/dev/idp-token・F3計画Task 13: 観測API)。
 * - POST /v1/dev/idp-token: ブラウザE2E・ローカル開発のサインイン入口。コミット済み
 *   テスト鍵(tests/fixturesの秘密JWK・docs/04 §4)でRS256署名したIdPトークンを返す
 *   (iss/audはテスト専用の固定値・exp=now+600秒)。受け取ったトークンは通常どおり
 *   POST /v1/auth/tokenで検証されるため、認証フローに特別経路を作らない
 * - GET /v1/dev/match-events・GET /v1/dev/match-candidates: F3パイプラインのE2Eが
 *   ゲートの合格証拠(match_eventsの計測payload・match_candidatesの生成記録)を
 *   観測するためのdev専用API。intent_idクエリは必須(ULID)・id降順・ページネーションは
 *   intents一覧と同じcursor方式(limit=1..50既定20・docs/05 §3.1)。所有者に限定しない
 *   (成立候補は2ユーザーのIntentで構成されるため・E2Eユーザーが証拠を読む経路)。
 *   応答はテーブル列の範囲のみ(raw_text等は含まれない)
 * - 存在を隠す(3ルート共通): LATCH_ENV==="production"、またはテスト鍵モードの変数
 *   (LATCH_TEST_IDP_PRIVATE_JWKS・LATCH_TEST_IDP_JWKS)が未設定のときは一律
 *   404 NOT_FOUND(理由は区別できない・docs/05 §3.1)。観測APIでは認証・クエリ検証より
 *   先に404へ倒す。prodでは加えてassertEnvSafetyが秘密鍵の設定自体を拒否する二重防御
 *   (docs/10 §2)
 * - 認証: idp-tokenは不要(サインインの入口のため)。観測APIはrequireRegistered
 *   (認証済みE2Eユーザーが使う)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点のためsystemClockをimportして使う
 */

import { devIdpTokenRequestSchema } from "@latch/shared";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono, type MiddlewareHandler } from "hono";
import { importJWK, SignJWT } from "jose";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../auth/idp";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { matchCandidates, matchEvents } from "../db/schema";
import type { Env } from "../env";
import { type ErrorResult, errorJson } from "../http/errors";
import { createLogger } from "../logging/logger";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。subjectは決して出力しない */
const logger = createLogger();

/** dev専用サインインのサブアプリ。index.tsが /v1/dev にマウントする */
export const devRoutes = new Hono<AppEnv>();

/** D1接続。envのバインディングからdrizzleインスタンスを作る(intents.tsと同一のhelper) */
const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** 発行するIdPトークンの寿命(秒・テストヘルパーsignIdpTokenと同じ600秒) */
const IDP_TOKEN_TTL_SECONDS = 600;

/** 秘密JWKの署名鍵への変換結果の簡易キャッシュ(鍵JSON文字列ごと・isolateで1回のimport) */
const signingKeyCache = new Map<string, Promise<CryptoKey>>();

/** 秘密JWK文字列→RS256署名鍵(importは非同期のためPromiseをキャッシュする) */
const signingKeyOf = (privateJwkJson: string): Promise<CryptoKey> => {
	let key = signingKeyCache.get(privateJwkJson);
	if (key === undefined) {
		key = importJWK(
			JSON.parse(privateJwkJson) as Record<string, unknown>,
			"RS256",
		) as Promise<CryptoKey>;
		signingKeyCache.set(privateJwkJson, key);
	}
	return key;
};

/** 存在を隠すための一律404(prod・テスト鍵未設定を区別しない) */
const notFound = (c: Context<AppEnv>): Response => {
	const r = errorJson("NOT_FOUND", "リソースが見つかりません");
	return c.json(r.body, r.status);
};

/**
 * 存在を隠すべきEnvか(idp-tokenと同一条件): prod、またはテスト鍵モードの
 * 2変数のいずれかが未設定(理由は区別しない・docs/05 §3.1)
 */
const isHiddenEnv = (env: Env): boolean =>
	env.LATCH_ENV === "production" ||
	env.LATCH_TEST_IDP_PRIVATE_JWKS === undefined ||
	env.LATCH_TEST_IDP_JWKS === undefined;

/**
 * 観測API2ルート共通の存在隠しミドルウェア。認証(requireRegistered)と
 * クエリ検証より先に一律404を返す(idp-tokenと同じ応答で、ルートの存在を
 * 確かめさせない・docs/05 §3.1)
 */
const hideWhenDisabled: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (isHiddenEnv(c.env)) {
		logger.warn("dev.observe.rejected", { error_code: "NOT_FOUND" });
		return notFound(c);
	}
	await next();
};

/** ULID(26文字・Crockford Base32)の照合(intents.tsの一覧cursor復号と同一の正規表現) */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/**
 * 一覧cursorの不透明化(docs/05 §3.1): ページの最終idをbase64url化する。
 * intents一覧(intents.ts)と同一方式の写し(ルートファイル間の共用はしない)
 */
const encodeCursor = (id: string): string =>
	btoa(id).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/**
 * cursor→最終id。base64urlとして復号できない・復号結果がULID(26文字・
 * Crockford Base32)の形でない場合はnull(呼び出し側が400にする)。
 * intents一覧と同一方式の写し
 */
const decodeCursor = (cursor: string): string | null => {
	let base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
	while (base64.length % 4 !== 0) {
		base64 += "=";
	}
	let decoded: string;
	try {
		decoded = atob(base64);
	} catch {
		return null;
	}
	return ULID_PATTERN.test(decoded) ? decoded : null;
};

/** 観測API共通クエリ(intent_id・limit・cursor)の検証結果 */
type ObserveQuery =
	| { ok: true; intentId: string; limit: number; cursorId?: string }
	| { ok: false; result: ErrorResult };

/**
 * 観測API共通のクエリ検証。
 * - intent_idは必須・ULID形式(欠落・形式外は400)
 * - limit=1..50既定20(intents一覧と同一の事前照合・範囲外は400)
 * - cursorは不透明(base64url化した最終id・復号できない値は400)
 */
const parseObserveQuery = (c: Context<AppEnv>): ObserveQuery => {
	const intentId = c.req.query("intent_id");
	if (intentId === undefined || !ULID_PATTERN.test(intentId)) {
		return {
			ok: false,
			result: errorJson(
				"VALIDATION_FAILED",
				"リクエストが不正です(intent_idはULID形式で指定してください)",
			),
		};
	}
	// limit=1..50既定20(docs/05 §3.1)。Number()は「1e1」「0x10」「 5 」等も数値化して
	// しまうため、先に「数字のみの1〜2桁」の事前照合を行う(intents一覧と同一)
	let limit = 20;
	const limitParam = c.req.query("limit");
	if (limitParam !== undefined) {
		if (!/^[0-9]{1,2}$/u.test(limitParam)) {
			return {
				ok: false,
				result: errorJson("VALIDATION_FAILED", "リクエストが不正です"),
			};
		}
		const parsedLimit = Number(limitParam);
		if (parsedLimit < 1 || parsedLimit > 50) {
			return {
				ok: false,
				result: errorJson("VALIDATION_FAILED", "リクエストが不正です"),
			};
		}
		limit = parsedLimit;
	}
	// cursorは不透明(base64url化した最終id)。復号できない値は400(docs/05 §3.1)
	let cursorId: string | undefined;
	const cursorParam = c.req.query("cursor");
	if (cursorParam !== undefined) {
		const decoded = decodeCursor(cursorParam);
		if (decoded === null) {
			return {
				ok: false,
				result: errorJson("VALIDATION_FAILED", "リクエストが不正です"),
			};
		}
		cursorId = decoded;
	}
	return { ok: true, intentId, limit, cursorId };
};

/** {items, next_cursor}の終端判定込み組立(intents一覧と同一方式) */
const pageBody = <T extends { id: string }>(
	items: T[],
	hasMore: boolean,
): {
	items: T[];
	next_cursor: string | null;
} => {
	const lastItem = items[items.length - 1];
	return {
		items,
		// 続きがあるときだけ「このページの最終id」を不透明化して返す
		next_cursor:
			hasMore && lastItem !== undefined ? encodeCursor(lastItem.id) : null,
	};
};

/** JSONボディを読む。空ボディは{}、JSON不正はundefined(400扱い) */
const readJsonBody = async (c: Context<AppEnv>): Promise<unknown> => {
	try {
		const text = await c.req.text();
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return undefined;
	}
};

devRoutes.post("/idp-token", async (c) => {
	// 存在を隠す検査をボディ検証より先に行う(存在しないルートと同じステータス(404)に
	// 見せる。ボディ検証の400を出さないことで、ルートの存在を確かめさせない)。
	// 公開JWKSの未設定も404に含める(署名できても検証できない構成では入口として無意味)
	if (isHiddenEnv(c.env)) {
		logger.warn("dev.signin.rejected", { error_code: "NOT_FOUND" });
		return notFound(c);
	}
	const parsed = devIdpTokenRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = errorJson("VALIDATION_FAILED", "リクエストボディが不正です");
		return c.json(r.body, r.status);
	}
	const privateJwkText = c.env.LATCH_TEST_IDP_PRIVATE_JWKS;
	if (privateJwkText === undefined) {
		// isHiddenEnvの404で済んでいるはず(到達しない・防御・docs/05 §3.1)
		return notFound(c);
	}
	const { kid } = JSON.parse(privateJwkText) as { kid: string };
	const nowSeconds = Math.floor(systemClock.now().getTime() / 1000);
	const idpToken = await new SignJWT({ sub: parsed.data.subject })
		.setProtectedHeader({ alg: "RS256", kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + IDP_TOKEN_TTL_SECONDS)
		.sign(await signingKeyOf(privateJwkText));
	// subject等は出さない(docs/08 §6の許可フィールドにも無い)
	logger.info("dev.signin.issued");
	return c.json({ idp_token: idpToken });
});

/** GET /v1/dev/match-eventsの1項目(match_events行の射影・日時はISO 8601) */
interface MatchEventItem {
	id: string;
	event_type: string;
	source_intent_id: string;
	version: number;
	status: string;
	/** payloadのjson列の中身(そのまま透過・E2Eが計測payloadを観測する) */
	payload: unknown;
	created_at: string;
	processed_at: string | null;
}

/** match_events行→観測項目。raw_text等はテーブルに無く含まれない */
const toMatchEventItem = (
	row: typeof matchEvents.$inferSelect,
): MatchEventItem => ({
	id: row.id,
	event_type: row.eventType,
	source_intent_id: row.sourceIntentId,
	version: row.version,
	status: row.status,
	payload: row.payload,
	created_at: row.createdAt.toISOString(),
	processed_at: row.processedAt === null ? null : row.processedAt.toISOString(),
});

/**
 * GET /v1/dev/match-events(観測API・F3計画Task 13)。
 * 指定Intentを起点(source_intent_id)とするmatch_events行=パイプラインへの
 * 投入記録をid降順で返す。存在隠し404 → requireRegistered → クエリ検証の順
 */
devRoutes.get(
	"/match-events",
	hideWhenDisabled,
	requireRegistered,
	async (c) => {
		const query = parseObserveQuery(c);
		if (!query.ok) {
			return c.json(query.result.body, query.result.status);
		}
		const conditions = [eq(matchEvents.sourceIntentId, query.intentId)];
		if (query.cursorId !== undefined) {
			// id降順の続きから=cursor(前ページの最終id)より小さいid
			conditions.push(lt(matchEvents.id, query.cursorId));
		}
		// 終端判定(next_cursor)のためにlimit+1件取得する(intents一覧と同一)
		const rows = await dbOf(c.env)
			.select()
			.from(matchEvents)
			.where(and(...conditions))
			.orderBy(desc(matchEvents.id))
			.limit(query.limit + 1);
		const hasMore = rows.length > query.limit;
		const items = (hasMore ? rows.slice(0, query.limit) : rows).map(
			toMatchEventItem,
		);
		return c.json(pageBody(items, hasMore), 200);
	},
);

/** GET /v1/dev/match-candidatesの1項目(match_candidates行の射影・日時はISO 8601) */
interface MatchCandidateItem {
	id: string;
	intent_a_id: string;
	intent_b_id: string;
	intent_a_version: number;
	intent_b_version: number;
	form: string;
	retrieval_score: number | null;
	cheap_judge_score: number | null;
	status: string;
	created_at: string;
	updated_at: string;
}

/** match_candidates行→観測項目。jev_result等の内部列は観測契約に含めない */
const toMatchCandidateItem = (
	row: typeof matchCandidates.$inferSelect,
): MatchCandidateItem => ({
	id: row.id,
	intent_a_id: row.intentAId,
	intent_b_id: row.intentBId,
	intent_a_version: row.intentAVersion,
	intent_b_version: row.intentBVersion,
	form: row.form,
	retrieval_score: row.retrievalScore,
	cheap_judge_score: row.cheapJudgeScore,
	status: row.status,
	created_at: row.createdAt.toISOString(),
	updated_at: row.updatedAt.toISOString(),
});

/**
 * GET /v1/dev/match-candidates(観測API・F3計画Task 13)。
 * 指定Intentをintent_aかintent_bのどちらかに含む1対1評価候補の生成記録を
 * id降順で返す。存在隠し404 → requireRegistered → クエリ検証の順
 */
devRoutes.get(
	"/match-candidates",
	hideWhenDisabled,
	requireRegistered,
	async (c) => {
		const query = parseObserveQuery(c);
		if (!query.ok) {
			return c.json(query.result.body, query.result.status);
		}
		const conditions = [
			// intent_a_idかintent_b_idのどちらかに一致(候補はペア行のため)
			or(
				eq(matchCandidates.intentAId, query.intentId),
				eq(matchCandidates.intentBId, query.intentId),
			),
		];
		if (query.cursorId !== undefined) {
			// id降順の続きから=cursor(前ページの最終id)より小さいid
			conditions.push(lt(matchCandidates.id, query.cursorId));
		}
		// 終端判定(next_cursor)のためにlimit+1件取得する(intents一覧と同一)
		const rows = await dbOf(c.env)
			.select()
			.from(matchCandidates)
			.where(and(...conditions))
			.orderBy(desc(matchCandidates.id))
			.limit(query.limit + 1);
		const hasMore = rows.length > query.limit;
		const items = (hasMore ? rows.slice(0, query.limit) : rows).map(
			toMatchCandidateItem,
		);
		return c.json(pageBody(items, hasMore), 200);
	},
);
