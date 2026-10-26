/**
 * 源流レート制限の統合試験(docs/04 §5・05 §3.1・10 §5・src/http/rate-limit.ts)。
 * - 1ユーザーあたり60req/分: 60回目は通り61回目が429(Retry-After 60・details.reason)。
 *   境界は数え方の決まった差し替えのバインディングで確かめ、実バインディング(miniflare)は
 *   上限を超えると429になることだけを確かめる(窓の境目をまたぐと回数がずれるため)
 * - 対象外のAPI: auth/token・auth/refresh・auth/logout・healthz・dev専用API
 * - 作成20件/日・更新6回/時間: 20件目は通り21件目が429・6回目は通り7回目が429。
 *   失敗した操作・表示系の変更・draftの編集は数えない
 * - 試験用の利用者の緩和(LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX)と、prodで緩和が効かないこと
 * 入口(default export)をenvを差し替えて直接呼び、応答の後の処理の完了まで待つ。
 */

import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { LIMITS } from "@latch/shared";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import type { Env as WorkerEnv } from "../src/env";
import { isRateLimitRelaxed } from "../src/http/rate-limit";
import worker from "../src/index";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as WorkerEnv;

const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/** テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud) */
const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(await signingKey());
};

/** 入口を直接呼ぶ(envを差し替えられる)。応答の後の処理(waitUntil)の完了まで待つ */
const call = async (
	method: string,
	path: string,
	options: { token?: string; body?: unknown; env?: WorkerEnv } = {},
): Promise<Response> => {
	const ctx = createExecutionContext();
	const headers: Record<string, string> = {};
	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const res = await worker.fetch(
		new Request(`https://localhost${path}`, {
			method,
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		}),
		options.env ?? testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
};

interface Session {
	access_token: string;
	refresh_token: string;
}

/** auth/token→POST /v1/usersで登録済みの利用者を作る(subjectの接頭辞を指定できる) */
const registerUser = async (prefix: string): Promise<Session> => {
	const tokenRes = await call("POST", "/v1/auth/token", {
		body: {
			provider: "google",
			idp_token: await signIdpToken(`${prefix}${crypto.randomUUID()}`),
		},
	});
	expect(tokenRes.status).toBe(200);
	const pre = (await tokenRes.json()) as { access_token: string };
	const regRes = await call("POST", "/v1/users", {
		token: pre.access_token,
		body: { display_name: "レート試験", birth_date: "1990-01-01" },
	});
	expect(regRes.status).toBe(201);
	return (await regRes.json()) as Session;
};

/** 回数を正確に数える差し替えのバインディング(Workers Rate Limitingと同じ形・keyごとにlimit回まで通す) */
const countingLimiter = (limit: number) => {
	const counts = new Map<string, number>();
	const keys: string[] = [];
	const limiter = {
		limit: async ({ key }: { key: string }) => {
			keys.push(key);
			const n = (counts.get(key) ?? 0) + 1;
			counts.set(key, n);
			return { success: n <= limit };
		},
	} as unknown as RateLimit;
	return { limiter, keys };
};

/** 常に拒否するバインディング(対象外のAPIが数えられないことの確認用) */
const alwaysLimited = {
	limit: async () => ({ success: false }),
} as unknown as RateLimit;

const withEnv = (overrides: Partial<WorkerEnv>): WorkerEnv => ({
	...testEnv,
	...overrides,
});

/**
 * 60req/分を常に通す環境(作成・更新の上限の試験用)。1人で1分に60回を超えて呼ぶため、
 * 実バインディングのままだと先に60req/分の429になる
 */
const unlimitedEnv = withEnv({
	API_RATE_LIMITER: {
		limit: async () => ({ success: true }),
	} as unknown as RateLimit,
});

interface ErrorBody {
	error: { code: string; details: { reason?: string } };
}

const expect429 = async (res: Response, reason: string): Promise<number> => {
	expect(res.status).toBe(429);
	const body = (await res.json()) as ErrorBody;
	expect(body.error.code).toBe("RATE_LIMITED");
	expect(body.error.details.reason).toBe(reason);
	const retryAfter = Number(res.headers.get("Retry-After"));
	expect(Number.isInteger(retryAfter)).toBe(true);
	return retryAfter;
};

/** draft保存の最小ボディ */
const draftBody = {
	raw_text: "週末に将棋を指す相手を探しています",
	status: "draft",
};

/** つながりIntentのactive作成の最小ボディ */
const activeBody = (topic: string) => ({
	raw_text: `${topic}。一緒にやりましょう。`,
	form: "connection",
	topic,
});

describe("1ユーザーあたり60req/分(docs/04 §5・05 §3.1)", () => {
	it("60回目までは通り、61回目は429(RATE_LIMITED・reason=requests_per_minute・Retry-After 60)", async () => {
		const user = await registerUser("rl-");
		const { limiter, keys } = countingLimiter(LIMITS.REQUESTS_PER_MINUTE);
		const e = withEnv({ API_RATE_LIMITER: limiter });
		for (let i = 1; i <= LIMITS.REQUESTS_PER_MINUTE; i++) {
			const res = await call("GET", "/v1/users/me", {
				token: user.access_token,
				env: e,
			});
			expect(res.status, `${i}回目`).toBe(200);
		}
		const res = await call("GET", "/v1/users/me", {
			token: user.access_token,
			env: e,
		});
		expect(await expect429(res, "requests_per_minute")).toBe(60);
		// keyは利用者のid(1人ぶんの要求はすべて同じkey)
		expect(new Set(keys).size).toBe(1);
	});

	it("利用者ごとに数える(別の利用者は止まらない)", async () => {
		const a = await registerUser("rl-");
		const b = await registerUser("rl-");
		const { limiter } = countingLimiter(1);
		const e = withEnv({ API_RATE_LIMITER: limiter });
		expect(
			(await call("GET", "/v1/users/me", { token: a.access_token, env: e }))
				.status,
		).toBe(200);
		await expect429(
			await call("GET", "/v1/users/me", { token: a.access_token, env: e }),
			"requests_per_minute",
		);
		expect(
			(await call("GET", "/v1/users/me", { token: b.access_token, env: e }))
				.status,
		).toBe(200);
	});

	it("登録前のトークンのAPI(POST /v1/users)も数える", async () => {
		const tokenRes = await call("POST", "/v1/auth/token", {
			body: {
				provider: "google",
				idp_token: await signIdpToken(`rl-${crypto.randomUUID()}`),
			},
		});
		const pre = (await tokenRes.json()) as { access_token: string };
		const res = await call("POST", "/v1/users", {
			token: pre.access_token,
			body: { display_name: "レート試験", birth_date: "1990-01-01" },
			env: withEnv({ API_RATE_LIMITER: alwaysLimited }),
		});
		await expect429(res, "requests_per_minute");
	});

	it("対象外のAPI(auth/token・auth/refresh・auth/logout・healthz・dev専用API)は数えない", async () => {
		const user = await registerUser("rl-");
		const e = withEnv({ API_RATE_LIMITER: alwaysLimited });
		expect((await call("GET", "/healthz", { env: e })).status).toBe(200);
		const idp = await call("POST", "/v1/dev/idp-token", {
			body: { subject: `rl-${crypto.randomUUID()}` },
			env: e,
		});
		expect(idp.status).toBe(200);
		const { idp_token } = (await idp.json()) as { idp_token: string };
		expect(
			(
				await call("POST", "/v1/auth/token", {
					body: { provider: "google", idp_token },
					env: e,
				})
			).status,
		).toBe(200);
		// dev専用の観測API(requireRegisteredを通る)も数えない
		expect(
			(
				await call("GET", "/v1/dev/usage?date=2026-10-26", {
					token: user.access_token,
					env: e,
				})
			).status,
		).toBe(200);
		const refreshed = await call("POST", "/v1/auth/refresh", {
			body: { refresh_token: user.refresh_token },
			env: e,
		});
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as Session;
		expect(
			(
				await call("POST", "/v1/auth/logout", {
					token: next.access_token,
					body: { refresh_token: next.refresh_token },
					env: e,
				})
			).status,
		).toBe(204);
		// 対象のAPIは同じ設定で429になる(差し替えが効いていることの確認)
		const other = await registerUser("rl-");
		await expect429(
			await call("GET", "/v1/users/me", { token: other.access_token, env: e }),
			"requests_per_minute",
		);
	});

	it("実バインディング(wrangler.jsoncのAPI_RATE_LIMITER)でも上限を超えると429になる", async () => {
		const user = await registerUser("rl-");
		// 窓の境目をまたいでも2つの窓で計120回までしか通らないため、125回のうちに必ず429が出る
		let limitedAt: number | null = null;
		for (let i = 1; i <= 125 && limitedAt === null; i++) {
			const res = await call("GET", "/v1/users/me", {
				token: user.access_token,
			});
			if (res.status === 429) {
				limitedAt = i;
			} else {
				expect(res.status).toBe(200);
			}
		}
		expect(limitedAt).not.toBeNull();
		expect(limitedAt as number).toBeGreaterThan(LIMITS.REQUESTS_PER_MINUTE);
	});
});

describe("Intent作成20件/日(docs/04 §5・draft保存も1件)", () => {
	it("20件目までは通り、21件目は429(reason=intent_creates_per_day・Retry-Afterは次のJSTの0時まで)", async () => {
		const user = await registerUser("rl-");
		for (let i = 1; i <= LIMITS.INTENT_CREATES_PER_DAY; i++) {
			const res = await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: draftBody,
			});
			expect(res.status, `${i}件目`).toBe(201);
		}
		const retryAfter = await expect429(
			await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: draftBody,
			}),
			"intent_creates_per_day",
		);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
	});

	it("失敗した作成(検証の400・参加中5件の上限の422)は数えない", async () => {
		const user = await registerUser("rl-");
		// 検証の失敗(raw_text欠落)を何度送っても数えない
		for (let i = 0; i < 25; i++) {
			const res = await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: { status: "draft" },
			});
			expect(res.status).toBe(400);
		}
		// activeを5件(上限)作り、6件目以降の422は数えない
		for (let i = 0; i < LIMITS.ACTIVE_INTENTS_PER_USER; i++) {
			const res = await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: activeBody(`将棋${i}`),
			});
			expect(res.status).toBe(201);
		}
		for (let i = 0; i < 20; i++) {
			const res = await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: activeBody("囲碁"),
			});
			expect(res.status).toBe(422);
		}
		// 数えたのはactiveの5件だけなので、あと15件のdraftが通る
		for (
			let i = 0;
			i < LIMITS.INTENT_CREATES_PER_DAY - LIMITS.ACTIVE_INTENTS_PER_USER;
			i++
		) {
			const res = await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: draftBody,
			});
			expect(res.status).toBe(201);
		}
		await expect429(
			await call("POST", "/v1/intents", {
				token: user.access_token,
				env: unlimitedEnv,
				body: draftBody,
			}),
			"intent_creates_per_day",
		);
	});
});

describe("Intent更新6回/時間(docs/04 §5・activeの意味フィールドの書き直しだけ)", () => {
	it("6回目までは通り、7回目は429(reason=intent_updates_per_hour・Retry-Afterは次のJSTの正時まで)", async () => {
		const user = await registerUser("rl-");
		const created = await call("POST", "/v1/intents", {
			token: user.access_token,
			env: unlimitedEnv,
			body: activeBody("将棋"),
		});
		const { id } = (await created.json()) as { id: string };
		for (let i = 1; i <= LIMITS.INTENT_UPDATES_PER_HOUR; i++) {
			const res = await call("PATCH", `/v1/intents/${id}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: `将棋${i}` },
			});
			expect(res.status, `${i}回目`).toBe(200);
		}
		const retryAfter = await expect429(
			await call("PATCH", `/v1/intents/${id}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: "将棋7" },
			}),
			"intent_updates_per_hour",
		);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(60 * 60);
		// 上限の後も表示系の変更(notification_level)は通る
		const display = await call("PATCH", `/v1/intents/${id}`, {
			token: user.access_token,
			env: unlimitedEnv,
			body: { notification_level: "muted" },
		});
		expect(display.status).toBe(200);
	});

	it("表示系の変更・draftの編集・active化・失敗した更新は数えない", async () => {
		const user = await registerUser("rl-");
		const draft = await call("POST", "/v1/intents", {
			token: user.access_token,
			env: unlimitedEnv,
			body: draftBody,
		});
		const { id: draftId } = (await draft.json()) as { id: string };
		// draftの編集を何度しても数えない
		for (let i = 0; i < 8; i++) {
			const res = await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: `下書き${i}` },
			});
			expect(res.status).toBe(200);
		}
		// active化も数えない
		const activated = await call("PATCH", `/v1/intents/${draftId}`, {
			token: user.access_token,
			env: unlimitedEnv,
			body: { form: "connection", topic: "将棋", status: "active" },
		});
		expect(activated.status).toBe(200);
		// 表示系(notification_level)だけの変更・同じ値の書き直しは数えない
		for (let i = 0; i < 8; i++) {
			const res = await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { notification_level: i % 2 === 0 ? "muted" : "proposals_only" },
			});
			expect(res.status).toBe(200);
			const same = await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: "将棋" },
			});
			expect(same.status).toBe(200);
		}
		// 失敗した更新(版の競合ではなく検証の400)は数えない
		for (let i = 0; i < 8; i++) {
			const res = await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: `将棋${i}`, raw_text: "変えられない" },
			});
			expect(res.status).toBe(400);
		}
		// 意味の変更はまだ6回できる
		for (let i = 1; i <= LIMITS.INTENT_UPDATES_PER_HOUR; i++) {
			const res = await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: `囲碁${i}` },
			});
			expect(res.status, `${i}回目`).toBe(200);
		}
		await expect429(
			await call("PATCH", `/v1/intents/${draftId}`, {
				token: user.access_token,
				env: unlimitedEnv,
				body: { topic: "囲碁7" },
			}),
			"intent_updates_per_hour",
		);
	});
});

describe("試験用の利用者の緩和(LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX・docs/10 §5)", () => {
	it("接頭辞で始まる利用者は3つの上限を外し、それ以外の利用者は止める", async () => {
		const e = withEnv({
			LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-,e2e-",
			API_RATE_LIMITER: alwaysLimited,
		});
		const relaxed = await registerUser("load-");
		const normal = await registerUser("rl-");
		expect(
			(
				await call("GET", "/v1/users/me", {
					token: relaxed.access_token,
					env: e,
				})
			).status,
		).toBe(200);
		await expect429(
			await call("GET", "/v1/users/me", { token: normal.access_token, env: e }),
			"requests_per_minute",
		);
		// 作成20件/日を超えても止めない
		for (let i = 0; i <= LIMITS.INTENT_CREATES_PER_DAY; i++) {
			const res = await call("POST", "/v1/intents", {
				token: relaxed.access_token,
				body: draftBody,
				env: e,
			});
			expect(res.status).toBe(201);
		}
		// 更新6回/時間を超えても止めない
		const e2e = await registerUser("e2e-");
		const created = await call("POST", "/v1/intents", {
			token: e2e.access_token,
			body: activeBody("将棋"),
			env: e,
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		for (let i = 0; i <= LIMITS.INTENT_UPDATES_PER_HOUR; i++) {
			const res = await call("PATCH", `/v1/intents/${id}`, {
				token: e2e.access_token,
				body: { topic: `将棋${i}` },
				env: e,
			});
			expect(res.status).toBe(200);
		}
	});

	it("prodでは接頭辞が設定されていても緩和しない(起動ガードとの二重防御)", () => {
		const prod = withEnv({
			LATCH_ENV: "production",
			LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-",
		});
		expect(isRateLimitRelaxed(prod, "load-1")).toBe(false);
		const staging = withEnv({
			LATCH_ENV: "staging",
			LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-",
		});
		expect(isRateLimitRelaxed(staging, "load-1")).toBe(true);
		expect(isRateLimitRelaxed(staging, "user-1")).toBe(false);
		expect(isRateLimitRelaxed(staging, undefined)).toBe(false);
		// 空の項目は捨てる(空の接頭辞で全員が外れることはない)
		const empty = withEnv({ LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: " , " });
		expect(isRateLimitRelaxed(empty, "user-1")).toBe(false);
	});
});
