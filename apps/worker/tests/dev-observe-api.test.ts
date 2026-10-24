/**
 * dev専用の観測API(GET /v1/dev/match-events・GET /v1/dev/match-candidates)の統合試験。
 * - E2E(Task 14)がゲート#6〜#13の証拠(match_eventsの計測payload・
 *   match_candidatesの生成記録)を観測するためのdev専用API
 * - 存在を隠す: POST /v1/dev/idp-tokenと同一条件(LATCH_ENV=production・テスト鍵
 *   2変数のいずれか未設定)で一律404・認証とクエリ検証より先(docs/05 §3.1)
 * - 認証: requireRegistered(未認証は401)。観測は所有者に限定しない(成立候補は
 *   2ユーザーのIntentで構成されるため・E2Eユーザーが証拠を読むための経路)
 * - ページネーションはintents一覧と同じcursor方式(id降順・limit=1..50既定20・
 *   cursorは不透明=base64url化した最終id・不正は400・docs/05 §3.1)
 * データ投入はSELF.fetchでdraft作成(FK用)した後、D1へ直接INSERTする
 * (行のidと件数を試験が制御するため)。実フロー経路の1本だけ
 * active作成→intent_created(pipeline-events.test.tsと同一パターン)で観測する。
 * env条件違いはdevRoutes.requestでEnvを差し替えて検証する(dev-api.test.tsと同一パターン)
 */

import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { monotonicFactory } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	intents,
	latches,
	matchCandidates,
	matchEvents,
	notifications,
	proposalHistory,
	reports,
} from "../src/db/schema";
import type { Env } from "../src/env";
import { devRoutes } from "../src/routes/dev";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

/** 試験がid順序を制御するための単調増加ULID生成器(同ms内でも必ず増える) */
const nextUlid = monotonicFactory();

/** テスト鍵の秘密JWK。viteの?rawでフィクスチャ文字列として読む(workerd内からは実FSを読めないため) */
const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

/** 署名鍵を遅延生成する(モジュール評価時に1回だけ) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/**
 * テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud)。
 * subは試験ごとにユニークにする
 */
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

/** JST=UTC+9の固定オフセット(誕生日計算をJST暦日基準に揃える・docs/01 §20) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 「JSTの今日からyears年前」の誕生日('YYYY-MM-DD')。統合試験はsystemClock(実時間)で動く */
const birthDateYearsAgo = (years: number): string => {
	const jstNow = new Date(Date.now() + JST_OFFSET_MS);
	return new Date(
		Date.UTC(
			jstNow.getUTCFullYear() - years,
			jstNow.getUTCMonth(),
			jstNow.getUTCDate(),
		),
	)
		.toISOString()
		.slice(0, 10);
};

/** JSONボディのPOSTリクエストヘルパー */
const postJson = (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

/** GETリクエストヘルパー(queryに?limit=等の素のクエリ文字列を渡せる) */
const getReq = (path: string, accessToken?: string): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "GET",
		headers:
			accessToken === undefined
				? {}
				: { Authorization: `Bearer ${accessToken}` },
	});

/** docs/05 §3.1のエラー応答の形状 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

/**
 * auth/token→POST /v1/usersで登録済みユーザーを作りアクセストークンを返す実フロー。
 * subjectは試験ごとにユニーク(intents-create-api.test.tsと同一パターン)
 */
const registerAccount = async (
	label: string,
): Promise<{ token: string; id: string }> => {
	const tokenRes = await postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
	});
	expect(tokenRes.status).toBe(200);
	const tokenBody = (await tokenRes.json()) as {
		access_token: string;
		registration_required: boolean;
	};
	expect(tokenBody.registration_required).toBe(true);
	const regRes = await postJson(
		"/v1/users",
		{ display_name: `${label}テスト`, birth_date: birthDateYearsAgo(25) },
		{ Authorization: `Bearer ${tokenBody.access_token}` },
	);
	expect(regRes.status).toBe(201);
	const regBody = (await regRes.json()) as {
		access_token: string;
		user: { id: string };
	};
	return { token: regBody.access_token, id: regBody.user.id };
};

/** 登録済みユーザーのアクセストークンのみを返す */
const registerUser = async (label: string): Promise<string> =>
	(await registerAccount(label)).token;

/** draft(FK用のIntent行・イベント発行は起きない)を作りidを返す */
const createDraftIntent = async (
	accessToken: string,
	rawText: string,
): Promise<string> => {
	const res = await postJson(
		"/v1/intents",
		{ raw_text: rawText, status: "draft" },
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
};

/** match_events行を直接INSERTしてidを返す(idは単調増加ULIDで順序を制御) */
const insertEvent = async (
	sourceIntentId: string,
	eventType: "intent_created" | "intent_updated",
	version: number,
	opts: {
		status?: "pending" | "processed";
		payload?: Record<string, unknown>;
		processedAt?: Date | null;
	} = {},
): Promise<string> => {
	const id = nextUlid();
	await db.insert(matchEvents).values({
		id,
		eventType,
		sourceIntentId,
		version,
		payload: opts.payload ?? {},
		status: opts.status ?? "pending",
		createdAt: new Date(),
		processedAt: opts.processedAt ?? null,
	});
	return id;
};

/** match_candidates行を直接INSERTしてidを返す(a<bへの正規化は実Tableと同じ規約) */
const insertCandidate = async (
	intentAId: string,
	intentBId: string,
	opts: {
		retrievalScore?: number | null;
		cheapJudgeScore?: number | null;
		status?: "candidate" | "proposed" | "closed";
	} = {},
): Promise<string> => {
	const id = nextUlid();
	await db.insert(matchCandidates).values({
		id,
		intentAId: intentAId < intentBId ? intentAId : intentBId,
		intentBId: intentAId < intentBId ? intentBId : intentAId,
		intentAVersion: 1,
		intentBVersion: 1,
		form: "connection",
		retrievalScore: opts.retrievalScore ?? null,
		cheapJudgeScore: opts.cheapJudgeScore ?? null,
		status: opts.status ?? "candidate",
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return id;
};

/** devRoutesへEnvを差し替えてGETするヘルパー(存在隠し404の単体検証) */
const getFromDevRoutes = async (
	path: string,
	overrideEnv: Partial<Env>,
): Promise<Response> =>
	await devRoutes.request(path, { method: "GET" }, {
		...testEnv,
		...overrideEnv,
	} as unknown as Env);

/** ISO 8601として解釈できること(toISOStringの応答規律)を確かめる */
const expectIso = (value: string): void => {
	expect(Number.isNaN(Date.parse(value))).toBe(false);
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GET /v1/dev/match-events", () => {
	it("データ投入後のitemsをid降順で返す・項目は契約どおりの8フィールド・ISO 8601", async () => {
		const accessToken = await registerUser("observe-evt");
		const intentId = await createDraftIntent(accessToken, "観測する学習仲間");
		const processedAt = new Date();
		const firstId = await insertEvent(intentId, "intent_created", 1, {
			payload: { queued: true },
		});
		const secondId = await insertEvent(intentId, "intent_updated", 2);
		const thirdId = await insertEvent(intentId, "intent_updated", 3, {
			status: "processed",
			processedAt,
		});

		const res = await getReq(
			`/v1/dev/match-events?intent_id=${intentId}`,
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
			next_cursor: string | null;
		};
		expect(body.items).toHaveLength(3);
		// id降順(ULID=新着順)
		expect(body.items.map((item) => item.id)).toEqual([
			thirdId,
			secondId,
			firstId,
		]);
		// 項目は8フィールドちょうど(過不足なし)
		expect(Object.keys(body.items[0]).sort()).toEqual(
			[
				"created_at",
				"event_type",
				"id",
				"payload",
				"processed_at",
				"source_intent_id",
				"status",
				"version",
			].sort(),
		);
		// processed行の内容(payloadはjson列の中身をそのまま・processed_atはISO)
		const processed = body.items[0] as {
			event_type: string;
			source_intent_id: string;
			version: number;
			status: string;
			payload: Record<string, unknown>;
			created_at: string;
			processed_at: string | null;
		};
		expect(processed.event_type).toBe("intent_updated");
		expect(processed.source_intent_id).toBe(intentId);
		expect(processed.version).toBe(3);
		expect(processed.status).toBe("processed");
		expect(processed.payload).toEqual({});
		expectIso(processed.created_at);
		expectIso(processed.processed_at as string);
		// 全行がnullでない processed_at を持つわけではない
		expect(
			(body.items[2] as { processed_at: string | null }).processed_at,
		).toBeNull();
		// 終端: 続きがなければnext_cursorはnull
		expect(body.next_cursor).toBeNull();
	});

	it("cursorページネーション(intents一覧と同じ方式)で続きを読める", async () => {
		const accessToken = await registerUser("observe-evt-page");
		const intentId = await createDraftIntent(
			accessToken,
			"ページングする学習仲間",
		);
		const firstId = await insertEvent(intentId, "intent_created", 1);
		const secondId = await insertEvent(intentId, "intent_updated", 2);
		const thirdId = await insertEvent(intentId, "intent_updated", 3);

		const page1 = (await (
			await getReq(
				`/v1/dev/match-events?intent_id=${intentId}&limit=2`,
				accessToken,
			)
		).json()) as { items: { id: string }[]; next_cursor: string | null };
		expect(page1.items.map((item) => item.id)).toEqual([thirdId, secondId]);
		expect(page1.next_cursor).not.toBeNull();

		const page2 = (await (
			await getReq(
				`/v1/dev/match-events?intent_id=${intentId}&limit=2&cursor=${page1.next_cursor as string}`,
				accessToken,
			)
		).json()) as { items: { id: string }[]; next_cursor: string | null };
		expect(page2.items.map((item) => item.id)).toEqual([firstId]);
		expect(page2.next_cursor).toBeNull();
	});

	it("active作成の実フローで発行されたintent_created(pending)を観測できる", async () => {
		const accessToken = await registerUser("observe-evt-flow");
		const sendSpy = vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});
		const res = await postJson(
			"/v1/intents",
			{
				raw_text: "実フローで観測する学習仲間。一緒にやりましょう。",
				form: "connection",
				topic: "実フローで観測する学習仲間",
			},
			{ Authorization: `Bearer ${accessToken}` },
		);
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string };
		// waitUntil内のemitMatchEvent(INSERT→send)の完了を待つ
		await vi.waitUntil(() => sendSpy.mock.calls.length >= 1, {
			timeout: 5_000,
			interval: 20,
		});
		const observed = (await (
			await getReq(`/v1/dev/match-events?intent_id=${created.id}`, accessToken)
		).json()) as {
			items: {
				event_type: string;
				version: number;
				status: string;
			}[];
			next_cursor: string | null;
		};
		expect(observed.items).toHaveLength(1);
		expect(observed.items[0].event_type).toBe("intent_created");
		expect(observed.items[0].version).toBe(1);
		expect(observed.items[0].status).toBe("pending");
		expect(observed.next_cursor).toBeNull();
	});

	it("limit不正(0・51・非数字)は400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("observe-evt-limit");
		const intentId = await createDraftIntent(accessToken, "上限を見る学習仲間");
		for (const limit of ["0", "51", "abc", "1.5"]) {
			const res = await getReq(
				`/v1/dev/match-events?intent_id=${intentId}&limit=${limit}`,
				accessToken,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("cursor不正(復号できない・ULIDでない)は400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("observe-evt-cursor");
		const intentId = await createDraftIntent(
			accessToken,
			"cursorを見る学習仲間",
		);
		for (const cursor of ["invalid_cursor", "!invalid"]) {
			const res = await getReq(
				`/v1/dev/match-events?intent_id=${intentId}&cursor=${cursor}`,
				accessToken,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("intent_id無し・ULID形式でないintent_idは400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("observe-evt-intent");
		for (const query of ["", `intent_id=${"x".repeat(26)}`]) {
			const res = await getReq(
				`/v1/dev/match-events${query === "" ? "" : `?${query}`}`,
				accessToken,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("未認証は401 UNAUTHORIZED", async () => {
		const accessToken = await registerUser("observe-evt-anon");
		const intentId = await createDraftIntent(accessToken, "認証を見る学習仲間");
		const res = await getReq(`/v1/dev/match-events?intent_id=${intentId}`);
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("GET /v1/dev/match-candidates", () => {
	it("intent_a・intent_bのどちらかに一致するitemsをid降順で返す・項目は11フィールド", async () => {
		const userA = await registerUser("observe-cand-a");
		const userB = await registerUser("observe-cand-b");
		const intentX = await createDraftIntent(userA, "候補Xになる学習仲間");
		const intentY = await createDraftIntent(userB, "候補Yになる学習仲間");
		const intentZ = await createDraftIntent(userB, "候補Zになる学習仲間");
		// Xは候補(X,Y)のintent_a側と(Z,X)のintent_b側の両方に現れる
		const firstId = await insertCandidate(intentX, intentY, {
			retrievalScore: 0.42,
			cheapJudgeScore: 0.5,
		});
		const secondId = await insertCandidate(intentZ, intentX, {
			retrievalScore: null,
			status: "proposed",
		});
		// Xを含まない候補(Xではない別ペア)は引っかからない
		await insertCandidate(intentY, intentZ);

		const res = await getReq(
			`/v1/dev/match-candidates?intent_id=${intentX}`,
			userA,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
			next_cursor: string | null;
		};
		expect(body.items).toHaveLength(2);
		expect(body.items.map((item) => item.id)).toEqual([secondId, firstId]);
		// 項目は13フィールドちょうど(過不足なし・prev_latch_score等の内部列は含まない)
		expect(Object.keys(body.items[0]).sort()).toEqual(
			[
				"cheap_judge_score",
				"created_at",
				"form",
				"id",
				"intent_a_id",
				"intent_a_version",
				"intent_b_id",
				"intent_b_version",
				"jev_result",
				"latch_score",
				"retrieval_score",
				"status",
				"updated_at",
			].sort(),
		);
		const first = body.items[1] as {
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
		};
		expect(first.intent_a_id).toBe(intentX);
		expect(first.intent_b_id).toBe(intentY);
		expect(first.intent_a_version).toBe(1);
		expect(first.intent_b_version).toBe(1);
		expect(first.form).toBe("connection");
		expect(first.retrieval_score).toBe(0.42);
		expect(first.cheap_judge_score).toBe(0.5);
		expect(first.status).toBe("candidate");
		expectIso(first.created_at);
		expectIso(first.updated_at);
		// nullスコアの行もそのままnullで返る
		const nullScored = body.items[0] as {
			retrieval_score: number | null;
			status: string;
		};
		expect(nullScored.retrieval_score).toBeNull();
		expect(nullScored.status).toBe("proposed");
		expect(body.next_cursor).toBeNull();
	});

	it("limit不正・cursor不正・intent_id無し・ULID形式外は400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("observe-cand-bad");
		const intentId = await createDraftIntent(accessToken, "検証を見る学習仲間");
		for (const query of [
			`intent_id=${intentId}&limit=0`,
			`intent_id=${intentId}&limit=51`,
			`intent_id=${intentId}&limit=abc`,
			`intent_id=${intentId}&cursor=invalid_cursor`,
			"limit=20",
			`intent_id=${"x".repeat(26)}`,
		]) {
			const res = await getReq(
				`/v1/dev/match-candidates?${query}`,
				accessToken,
			);
			expect(res.status, `query=${query}`).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("未認証は401 UNAUTHORIZED", async () => {
		const accessToken = await registerUser("observe-cand-anon");
		const intentId = await createDraftIntent(accessToken, "認証を見る学習仲間");
		const res = await getReq(`/v1/dev/match-candidates?intent_id=${intentId}`);
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("存在を隠す(dev-api.test.tsと同一条件・認証と検証より先に404)", () => {
	it("LATCH_ENV=production相当ではクエリが正しくても404 NOT_FOUND(未認証でも401より先の404)", async () => {
		const intentId = nextUlid();
		for (const path of [
			`/match-events?intent_id=${intentId}`,
			"/match-events",
			`/match-candidates?intent_id=${intentId}`,
		]) {
			const res = await getFromDevRoutes(path, { LATCH_ENV: "production" });
			expect(res.status, `path=${path}`).toBe(404);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("NOT_FOUND");
		}
	});

	it("テスト鍵2変数のいずれかが未設定でも404(idp-tokenと同一条件)", async () => {
		const intentId = nextUlid();
		for (const override of [
			{ LATCH_TEST_IDP_PRIVATE_JWKS: undefined },
			{ LATCH_TEST_IDP_JWKS: undefined },
		]) {
			for (const path of [
				`/match-events?intent_id=${intentId}`,
				`/match-candidates?intent_id=${intentId}`,
			]) {
				const res = await getFromDevRoutes(path, override);
				expect(res.status, `path=${path}`).toBe(404);
				const body = (await res.json()) as ErrorResponse;
				expect(body.error.code).toBe("NOT_FOUND");
			}
		}
	});

	it("観測APIの404はidp-tokenの404と同じ応答(理由を区別できない)", async () => {
		const idpRes = await devRoutes.request(
			"/idp-token",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "dev" }),
			},
			{ ...testEnv, LATCH_ENV: "production" } as unknown as Env,
		);
		expect(idpRes.status).toBe(404);
		const idpBody = (await idpRes.json()) as ErrorResponse;
		const observeRes = await getFromDevRoutes(
			`/match-events?intent_id=${nextUlid()}`,
			{ LATCH_ENV: "production" },
		);
		expect(observeRes.status).toBe(404);
		const observeBody = (await observeRes.json()) as ErrorResponse;
		expect(observeBody.error.message).toBe(idpBody.error.message);
		expect(observeBody.error.details).toEqual({});
	});
});

/** 試験用に直接INSERTする(FK不要な)LATCH行。時刻は固定値で比較しやすくする */
const insertLatch = async (
	intentIds: string[],
	opts: { score?: number; proposedAt?: Date | null } = {},
): Promise<string> => {
	const id = nextUlid();
	const now = new Date();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds,
		proposal: {},
		score: opts.score ?? 0.8,
		status: "proposed",
		responseDeadline: new Date(now.getTime() + 3600_000),
		expiresAt: new Date(now.getTime() + 86400_000),
		lastMessageAt: now,
		completedAt: null,
		proposedAt: opts.proposedAt === undefined ? now : opts.proposedAt,
		createdAt: now,
		updatedAt: now,
	});
	return id;
};

/** proposal_history行を直接INSERTする(user_low<user_highへ正規化) */
const insertHistory = async (
	userA: string,
	userB: string,
	latchId: string | null,
): Promise<string> => {
	const id = nextUlid();
	const now = new Date();
	await db.insert(proposalHistory).values({
		id,
		userLow: userA < userB ? userA : userB,
		userHigh: userA < userB ? userB : userA,
		latchId,
		outcome: "proposed",
		createdAt: now,
		updatedAt: now,
	});
	return id;
};

/** backdate呼び出しヘルパー */
const backdateRequest = (
	latchId: string,
	body: unknown,
	token: string,
): Promise<Response> =>
	postJson(`/v1/dev/latches/${latchId}/backdate`, body, {
		Authorization: `Bearer ${token}`,
	});

describe("POST /v1/dev/latches/:id/backdate", () => {
	it("response_deadlineとhistory.updated_atを書き換える", async () => {
		const a = await registerAccount("backdate-a");
		const b = await registerAccount("backdate-b");
		const latchId = await insertLatch([nextUlid(), nextUlid()]);
		const historyId = await insertHistory(a.id, b.id, latchId);
		const past = "2020-01-01T00:00:00.000Z";
		const res = await backdateRequest(
			latchId,
			{ response_deadline: past, history_updated_at: past },
			a.token,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const [latch] = await db
			.select()
			.from(latches)
			.where(eq(latches.id, latchId));
		expect(latch.responseDeadline.toISOString()).toBe(past);
		const [history] = await db
			.select()
			.from(proposalHistory)
			.where(eq(proposalHistory.id, historyId));
		expect(history.updatedAt.toISOString()).toBe(past);
	});

	it("intents_last_evaluated_atが参加Intent全員に反映される", async () => {
		const a = await registerAccount("backdate-eval");
		const i1 = await createDraftIntent(a.token, "再評価抑制を外す1");
		const i2 = await createDraftIntent(a.token, "再評価抑制を外す2");
		const other = await createDraftIntent(a.token, "無関係");
		const latchId = await insertLatch([i1, i2]);
		const past = "2020-01-01T00:00:00.000Z";
		const res = await backdateRequest(
			latchId,
			{ intents_last_evaluated_at: past },
			a.token,
		);
		expect(res.status).toBe(200);
		for (const id of [i1, i2]) {
			const [row] = await db.select().from(intents).where(eq(intents.id, id));
			expect(row.lastEvaluatedAt?.toISOString()).toBe(past);
		}
		const [untouched] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, other));
		expect(untouched.lastEvaluatedAt).toBeNull();
	});

	it("不正入力(空・未知キー・非ISO)は400・存在しないLATCHは404", async () => {
		const a = await registerAccount("backdate-bad");
		const latchId = await insertLatch([nextUlid(), nextUlid()]);
		for (const bad of [
			{},
			{ response_deadline: "あした" },
			{ response_deadline: "2020-01-01T00:00:00.000Z", extra: 1 },
		]) {
			const res = await backdateRequest(latchId, bad, a.token);
			expect(res.status).toBe(400);
			expect(((await res.json()) as ErrorResponse).error.code).toBe(
				"VALIDATION_FAILED",
			);
		}
		const missing = await backdateRequest(
			nextUlid(),
			{ response_deadline: "2020-01-01T00:00:00.000Z" },
			a.token,
		);
		expect(missing.status).toBe(404);
	});

	it("prod相当のenvでは認証より先に404", async () => {
		const res = await devRoutes.request(
			`/latches/${nextUlid()}/backdate`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ response_deadline: "2020-01-01T00:00:00.000Z" }),
			},
			{ ...testEnv, LATCH_ENV: "production" } as unknown as Env,
		);
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/dev/latches・GET /v1/dev/proposal-history", () => {
	it("latchesはintent_idがintent_idsに含まれる行のみをid降順で返す", async () => {
		const a = await registerAccount("obs-latch");
		const target = nextUlid();
		const first = await insertLatch([target, nextUlid()], { score: 0.7 });
		await insertLatch([nextUlid(), nextUlid()]);
		const third = await insertLatch([nextUlid(), target], {
			proposedAt: null,
		});
		const res = await getReq(`/v1/dev/latches?intent_id=${target}`, a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
			next_cursor: string | null;
		};
		expect(body.items.map((i) => i.id)).toEqual([third, first]);
		expect(Object.keys(body.items[0]).sort()).toEqual(
			[
				"form",
				"id",
				"intent_ids",
				"proposed_at",
				"response_deadline",
				"score",
				"status",
			].sort(),
		);
		expect(body.items[0].proposed_at).toBeNull();
		expectIso(body.items[1].proposed_at as string);
		expectIso(body.items[1].response_deadline as string);
		expect(body.items[1].score).toBe(0.7);
		expect(body.next_cursor).toBeNull();
	});

	it("proposal-historyはuser_low/highのどちらかが一致する行を返し、形式外user_idは400", async () => {
		const a = await registerAccount("obs-hist-a");
		const b = await registerAccount("obs-hist-b");
		const c = await registerAccount("obs-hist-c");
		const ab = await insertHistory(a.id, b.id, null);
		const ca = await insertHistory(c.id, a.id, null);
		await insertHistory(b.id, c.id, null);
		const res = await getReq(
			`/v1/dev/proposal-history?user_id=${a.id}`,
			a.token,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
			next_cursor: string | null;
		};
		expect(body.items.map((i) => i.id)).toEqual([ca, ab]);
		expect(Object.keys(body.items[0]).sort()).toEqual(
			[
				"created_at",
				"id",
				"latch_id",
				"outcome",
				"updated_at",
				"user_high",
				"user_low",
			].sort(),
		);
		const bad = await getReq("/v1/dev/proposal-history?user_id=xyz", a.token);
		expect(bad.status).toBe(400);
	});

	it("match-candidatesにjev_resultとlatch_scoreが出る", async () => {
		const token = await registerUser("obs-jev");
		const x = await createDraftIntent(token, "Jev観測1");
		const y = await createDraftIntent(token, "Jev観測2");
		const id = await insertCandidate(x, y);
		await db
			.update(matchCandidates)
			.set({ jevResult: { topic: 0.9 }, latchScore: 0.75 })
			.where(eq(matchCandidates.id, id));
		const res = await getReq(`/v1/dev/match-candidates?intent_id=${x}`, token);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items[0].jev_result).toEqual({ topic: 0.9 });
		expect(body.items[0].latch_score).toBe(0.75);
	});

	it("新規観測APIもprod相当envでは404", async () => {
		for (const path of [
			`/latches?intent_id=${nextUlid()}`,
			`/proposal-history?user_id=${nextUlid()}`,
		]) {
			const res = await getFromDevRoutes(path, { LATCH_ENV: "production" });
			expect(res.status, path).toBe(404);
		}
	});
});

describe("GET /v1/dev/reports", () => {
	it("本人の通報だけをcreated_at降順で返す", async () => {
		const a = await registerAccount("devrep-a");
		const b = await registerAccount("devrep-b");
		const t0 = Date.now();
		const mk = (reporter: string, i: number, note: string) => ({
			id: nextUlid(),
			reporter,
			reportee: b.id,
			reason: "spam" as const,
			target: "profile" as const,
			latchId: nextUlid(),
			messageId: null,
			note,
			status: "open" as const,
			createdAt: new Date(t0 + i * 1000),
		});
		await db
			.insert(reports)
			.values([
				mk(a.id, 0, "古い"),
				mk(a.id, 1, "新しい"),
				mk(b.id, 2, "他人"),
			]);
		const res = await getReq("/v1/dev/reports", a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			reports: Array<{ note: string; created_at: string; reportee: string }>;
		};
		expect(body.reports.map((r) => r.note)).toEqual(["新しい", "古い"]);
		expectIso(body.reports[0]?.created_at as string);
		expect(Object.keys(body.reports[0] as object).sort()).toEqual(
			[
				"created_at",
				"id",
				"latch_id",
				"message_id",
				"note",
				"reason",
				"reportee",
				"status",
				"target",
			].sort(),
		);
	});

	it("存在隠し: production相当では404", async () => {
		const res = await getFromDevRoutes("/reports", { LATCH_ENV: "production" });
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/dev/notifications", () => {
	it("本人の通知だけをid降順で返す(push_stateを含む)", async () => {
		const a = await registerAccount("devnot-a");
		const b = await registerAccount("devnot-b");
		const t0 = Date.now();
		const mk = (
			userId: string,
			i: number,
			pushState: "pending" | "sent" | "none",
		) => ({
			id: nextUlid(),
			userId,
			type: "proposal" as const,
			latchId: nextUlid(),
			intentId: null,
			readAt: null,
			createdAt: new Date(t0 + i * 1000),
			pushState,
			pushAttemptedAt: pushState === "sent" ? new Date(t0) : null,
		});
		const rows = [
			mk(a.id, 0, "sent"),
			mk(a.id, 1, "pending"),
			mk(b.id, 2, "none"),
		];
		await db.insert(notifications).values(rows);
		const res = await getReq("/v1/dev/notifications", a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			notifications: Array<{ id: string; push_state: string }>;
		};
		expect(body.notifications.map((n) => n.id)).toEqual(
			[rows[1]?.id, rows[0]?.id].sort().reverse(),
		);
		expect(body.notifications.map((n) => n.push_state).sort()).toEqual([
			"pending",
			"sent",
		]);
		expect(Object.keys(body.notifications[0] as object).sort()).toEqual(
			[
				"created_at",
				"id",
				"intent_id",
				"latch_id",
				"push_attempted_at",
				"push_state",
				"read_at",
				"type",
			].sort(),
		);
	});

	it("存在隠し: production相当では404", async () => {
		const res = await getFromDevRoutes("/notifications", {
			LATCH_ENV: "production",
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/dev/usage", () => {
	it("指定日の外部送信の回数を返す", async () => {
		const a = await registerAccount("devusage");
		await testEnv.DB.prepare(
			"INSERT INTO usage_counters (scope, key, period, count) VALUES ('external_send','anthropic:parser','2032-01-05',3)",
		).run();
		const res = await getReq("/v1/dev/usage?date=2032-01-05", a.token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			date: "2032-01-05",
			counts: { "anthropic:parser": 3 },
		});
		const bad = await getReq("/v1/dev/usage?date=nope", a.token);
		expect(bad.status).toBe(400);
	});

	it("存在隠し: production相当では404", async () => {
		const res = await getFromDevRoutes("/usage?date=2032-01-05", {
			LATCH_ENV: "production",
		});
		expect(res.status).toBe(404);
	});
});
