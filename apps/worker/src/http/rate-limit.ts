/**
 * 源流レート制限(docs/04 §5・05 §3.1)。3つの上限を利用者単位で数える。
 * - 1ユーザーあたり60req/分: Workers Rate Limitingバインディング(API_RATE_LIMITER・
 *   key=利用者)。認証ミドルウェアが認証の成功の直後に確かめる(checkRequestRateLimit)。
 *   バインディングはCloudflareの拠点ごとのおおよその数え方で、多少の超過を許す
 * - Intent作成20件/日・更新6回/時間: usage_counters(scope=intent_daily・intent_hourly・
 *   key=user_id・periodはJSTの日付・時)。条件付きの加算1文で確保し、作成・更新が
 *   失敗したら戻す(reserveIntentQuota・releaseIntentQuota)。成功した操作だけを数える
 * 試験用の利用者の緩和(docs/10 §5): LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIXに書いた接頭辞
 * (カンマ区切り)でidp_subjectが始まる利用者は3つとも数えない。prodでは設定自体を
 * 起動ガードが拒否する(src/env.ts)
 */

import { LIMITS } from "@latch/shared";
import type { Context } from "hono";
import type { AccessClaims } from "../auth/jwt";
import type { AppEnv } from "../auth/middleware";
import { jstDayKey, jstHourKey } from "../clock/clock";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";
import { errorJson } from "./errors";

const logger = createLogger();

/** 429の理由(details.reason)。画面は理由ごとに案内を出し分ける(docs/05 §3.1) */
export type RateLimitReason =
	| "requests_per_minute"
	| "intent_creates_per_day"
	| "intent_updates_per_hour";

/** 60req/分の429のRetry-After(固定60秒・docs/04 §5) */
export const REQUEST_RATE_RETRY_AFTER_SECONDS = 60;

/**
 * 60req/分の対象外のパス(docs/05 §3.1)。ログアウトはいつでもできるようにし、dev専用APIは
 * stagingの通し試験の観測の待ちが数え込まれないようにする。auth/token・auth/refresh・
 * healthz・アイコンの取得・WebSocket(チケット認証)は認証ミドルウェアを通らないため
 * もともと数えない
 */
const EXEMPT_PATH_PREFIXES = ["/v1/auth/logout", "/v1/dev/"];

/** 緩和の接頭辞の一覧(空の項目は捨てる) */
const relaxPrefixes = (env: Env): string[] =>
	(env.LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "");

/** 試験用の利用者として3つの上限を外すか(prodでは設定が起動ガードで拒否される) */
export const isRateLimitRelaxed = (
	env: Env,
	idpSubject: string | undefined,
): boolean => {
	if (env.LATCH_ENV === "production" || idpSubject === undefined) {
		return false;
	}
	return relaxPrefixes(env).some((p) => idpSubject.startsWith(p));
};

/** 429の応答(docs/05 §3.1の共通形状・Retry-After付き) */
export const rateLimitedResponse = (
	c: Context<AppEnv>,
	reason: RateLimitReason,
	retryAfterSeconds: number,
): Response => {
	logger.warn("api.rate_limited", { error_code: reason });
	const r = errorJson(
		"RATE_LIMITED",
		"操作の回数が上限に達しました。時間をおいて、もう一度お試しください",
		{ reason },
	);
	c.header("Retry-After", String(retryAfterSeconds));
	return c.json(r.body, r.status);
};

/**
 * 60req/分を確かめる(認証の成功の直後に呼ぶ)。超えていれば429の応答を、通せばnullを返す。
 * keyは登録済みならuser_id、登録前(subが無い)ならIdPの種類とsubject
 */
export const checkRequestRateLimit = async (
	c: Context<AppEnv>,
	claims: AccessClaims,
): Promise<Response | null> => {
	if (EXEMPT_PATH_PREFIXES.some((p) => c.req.path.startsWith(p))) {
		return null;
	}
	if (isRateLimitRelaxed(c.env, claims.idpSubject)) {
		return null;
	}
	const key =
		claims.sub ?? `pre:${claims.idpProvider ?? ""}:${claims.idpSubject ?? ""}`;
	const { success } = await c.env.API_RATE_LIMITER.limit({ key });
	if (success) {
		return null;
	}
	return rateLimitedResponse(
		c,
		"requests_per_minute",
		REQUEST_RATE_RETRY_AFTER_SECONDS,
	);
};

/** 作成・更新の上限の種類 */
export type IntentQuotaKind = "create" | "update";

const QUOTA = {
	create: {
		scope: "intent_daily",
		limit: LIMITS.INTENT_CREATES_PER_DAY,
		period: jstDayKey,
		reason: "intent_creates_per_day",
	},
	update: {
		scope: "intent_hourly",
		limit: LIMITS.INTENT_UPDATES_PER_HOUR,
		period: jstHourKey,
		reason: "intent_updates_per_hour",
	},
} as const;

/** 確保の結果。拒否のときは429の理由と、窓が戻るまでの秒数(Retry-After) */
export type IntentQuotaResult =
	| { ok: true; release: () => Promise<void> }
	| { ok: false; reason: RateLimitReason; retryAfterSeconds: number };

const MS_PER_HOUR = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * MS_PER_HOUR;

/** 次のJSTの0時・正時までの秒数(1以上) */
const secondsUntilNextWindow = (kind: IntentQuotaKind, now: Date): number => {
	const span = kind === "create" ? 24 * MS_PER_HOUR : MS_PER_HOUR;
	const shifted = now.getTime() + JST_OFFSET_MS;
	const rest = span - (shifted % span);
	return Math.max(1, Math.ceil(rest / 1000));
};

/**
 * 作成20件/日・更新6回/時間の1回分を確保する(上限未満のときだけ加算する1文)。
 * 呼び出し側は操作が失敗したらrelease()で戻す。緩和の対象は数えずに通す
 */
export const reserveIntentQuota = async (
	env: Env,
	kind: IntentQuotaKind,
	userId: string,
	idpSubject: string | undefined,
	now: Date,
): Promise<IntentQuotaResult> => {
	if (isRateLimitRelaxed(env, idpSubject)) {
		return { ok: true, release: async () => {} };
	}
	const q = QUOTA[kind];
	const period = q.period(now);
	// 既存の行は上限未満のときだけ加算する。上限なら更新されず、RETURNINGが行を返さない
	const row = await env.DB.prepare(
		"INSERT INTO usage_counters (scope, key, period, count) VALUES (?, ?, ?, 1) " +
			"ON CONFLICT (scope, key, period) DO UPDATE SET count = count + 1 WHERE count < ? " +
			"RETURNING count",
	)
		.bind(q.scope, userId, period, q.limit)
		.first<{ count: number }>();
	if (row === null) {
		return {
			ok: false,
			reason: q.reason,
			retryAfterSeconds: secondsUntilNextWindow(kind, now),
		};
	}
	return {
		ok: true,
		release: async () => {
			await env.DB.prepare(
				"UPDATE usage_counters SET count = count - 1 WHERE scope = ? AND key = ? AND period = ? AND count > 0",
			)
				.bind(q.scope, userId, period)
				.run();
		},
	};
};
