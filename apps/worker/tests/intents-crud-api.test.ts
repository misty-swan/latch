/**
 * Intent API(一覧・取得・更新・削除)の統合試験。
 * docs/05 §3.1(ページネーション・他人のIntentは存在を隠すため一律404)・
 * §3.2(エンドポイント・activeの可変フィールド)・§2.2(active化検証・期限)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得する
 * (intents-create-api.test.tsと同一パターン)。
 */

import { env, SELF } from "cloudflare:test";
import { type IntentDTO, OCCASION_DEFAULT_TTL_HOURS } from "@latch/shared";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	groupCandidates,
	intents,
	latches,
	latchMembers,
	matchEvents,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import { MS_PER_DAY } from "../src/intents/expiry";
import { updateWithOptimisticLock } from "../src/routes/intents";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

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

/** PATCHリクエストヘルパー */
const patchJson = (
	path: string,
	body: unknown,
	accessToken: string,
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "PATCH",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(body),
	});

/** DELETEリクエストヘルパー */
const deleteReq = (path: string, accessToken: string): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

/** docs/05 §3.1のエラー応答の形状(details.reasonsに理由コードを載せる場合がある) */
interface ErrorResponse {
	error: { code: string; message: string; details: { reasons?: string[] } };
}

/**
 * auth/token→POST /v1/usersで登録済みユーザーを作りアクセストークンを返す実フロー。
 * subjectは試験ごとにユニーク
 */
const registerUser = async (
	label: string,
	birthDate: string = birthDateYearsAgo(25),
): Promise<string> => {
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
		{ display_name: `${label}テスト`, birth_date: birthDate },
		{ Authorization: `Bearer ${tokenBody.access_token}` },
	);
	expect(regRes.status).toBe(201);
	const regBody = (await regRes.json()) as { access_token: string };
	return regBody.access_token;
};

/** つながりactive作成の最小ボディ(主題のみ) */
const connectionBody = (
	topic: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	raw_text: `${topic}。一緒にやりましょう。`,
	form: "connection",
	topic,
	...extra,
});

/** つながりactiveを作りDTOを返す */
const createActiveConnection = async (
	accessToken: string,
	topic: string,
): Promise<IntentDTO> => {
	const res = await postJson("/v1/intents", connectionBody(topic), {
		Authorization: `Bearer ${accessToken}`,
	});
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** draft(raw_textのみ)を作りDTOを返す */
const createDraft = async (
	accessToken: string,
	extra: Record<string, unknown> = {},
): Promise<IntentDTO> => {
	const res = await postJson(
		"/v1/intents",
		{
			raw_text: "まだぼんやりだけど、いつかサーフィンを始めたい",
			status: "draft",
			...extra,
		},
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/**
 * 期限の実行時ずれを許す比較。ルートのsystemClockと試験側のDate.now()には
 * 処理時間ぶんの差が生じるため、5秒以内の一致をもって「now+30日」等とみなす
 */
const expiresNear = (
	dto: { expires_at: string | null },
	expectedMs: number,
): boolean =>
	dto.expires_at !== null &&
	Math.abs(new Date(dto.expires_at).getTime() - expectedMs) < 5000;

/** 一覧応答の形状(docs/05 §3.1: {items, next_cursor}) */
interface IntentsListResponse {
	items: IntentDTO[];
	next_cursor: string | null;
}

describe("GET /v1/intents(一覧・docs/05 §3.1・§3.2)", () => {
	it("3件(うち1件draft)作成すると無印GETで3件・id降順(新着順)で返る", async () => {
		const accessToken = await registerUser("list");
		await createActiveConnection(accessToken, "1件目の学習仲間");
		await createActiveConnection(accessToken, "2件目の学習仲間");
		const draft = await createDraft(accessToken);
		const res = await getReq("/v1/intents", accessToken);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentsListResponse;
		expect(body.items).toHaveLength(3);
		// id降順(ULID=新着順): 最後に作ったdraftが先頭
		expect(body.items[0]?.id).toBe(draft.id);
		expect(body.items[0]?.id > (body.items[1]?.id as string)).toBe(true);
		expect(body.items[1]?.id > (body.items[2]?.id as string)).toBe(true);
		expect(body.items[0]?.topic).toBeNull();
		expect(body.items[1]?.topic).toBe("2件目の学習仲間");
		expect(body.items[2]?.topic).toBe("1件目の学習仲間");
		// 要素はIntentDTOの形(全項目)
		expect(body.items[1]).toEqual(
			expect.objectContaining({
				status: "active",
				version: 1,
				visibility: "hidden_until_match",
			}),
		);
	});

	it("?status=draftでdraftのみ1件返る", async () => {
		const accessToken = await registerUser("list-status");
		await createActiveConnection(accessToken, "有効な学習仲間");
		const draft = await createDraft(accessToken);
		const res = await getReq("/v1/intents?status=draft", accessToken);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentsListResponse;
		expect(body.items).toHaveLength(1);
		expect(body.items[0]?.id).toBe(draft.id);
		expect(body.items[0]?.status).toBe("draft");
		expect(body.next_cursor).toBeNull();
	});

	it("?limit=2で2件・next_cursor続き→cursorで残り1件・next_cursor=null", async () => {
		const accessToken = await registerUser("list-cursor");
		const first = await createActiveConnection(accessToken, "1番目の学習仲間");
		const second = await createActiveConnection(accessToken, "2番目の学習仲間");
		const third = await createDraft(accessToken);
		const page1Res = await getReq("/v1/intents?limit=2", accessToken);
		expect(page1Res.status).toBe(200);
		const page1 = (await page1Res.json()) as IntentsListResponse;
		expect(page1.items.map((item) => item.id)).toEqual([third.id, second.id]);
		expect(page1.next_cursor).not.toBeNull();
		// cursorは不透明(base64url化した最終id)。元idをそのまま含まない
		expect(page1.next_cursor).not.toContain(second.id);
		const page2Res = await getReq(
			`/v1/intents?limit=2&cursor=${page1.next_cursor as string}`,
			accessToken,
		);
		expect(page2Res.status).toBe(200);
		const page2 = (await page2Res.json()) as IntentsListResponse;
		expect(page2.items.map((item) => item.id)).toEqual([first.id]);
		expect(page2.next_cursor).toBeNull();
	});

	it("limit=51・limit=0・limit=1e1・limit=0x10・不正cursor・不正statusは400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("list-invalid");
		for (const query of [
			"?limit=51",
			"?limit=0",
			// Number()では数値化されるが契約は「数字のみの1〜2桁」のため400(docs/05 §3.1)
			"?limit=1e1",
			"?limit=0x10",
			"?cursor=@@@not-base64@@@",
			"?status=archived",
		]) {
			const res = await getReq(`/v1/intents${query}`, accessToken);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("未認証は401 UNAUTHORIZED", async () => {
		const res = await getReq("/v1/intents");
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("GET /v1/intents/{id}(取得・docs/05 §3.1・§3.2)", () => {
	it("自分のIntentは200・保存値と一致するDTOで返る", async () => {
		const accessToken = await registerUser("get-own");
		const created = await createActiveConnection(
			accessToken,
			"取得対象の学習仲間",
		);
		const res = await getReq(`/v1/intents/${created.id}`, accessToken);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.id).toBe(created.id);
		expect(body.topic).toBe("取得対象の学習仲間");
		expect(body.status).toBe("active");
		expect(body.version).toBe(1);
	});

	it("他人のIntentは404(存在を隠す・FORBIDDENにしない)", async () => {
		const owner = await registerUser("get-owner");
		const other = await registerUser("get-other");
		const created = await createActiveConnection(
			owner,
			"他人には見えない学習仲間",
		);
		const res = await getReq(`/v1/intents/${created.id}`, other);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("存在しないidは404", async () => {
		const accessToken = await registerUser("get-missing");
		const res = await getReq(`/v1/intents/${ulid()}`, accessToken);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("PATCH /v1/intents/{id}・draft状態(docs/05 §3.2: 全項目可変+active化)", () => {
	it("topic等の部分更新は200・version=2・他フィールドは現行値のまま", async () => {
		const accessToken = await registerUser("patch-draft");
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ topic: "下書きに主題を追加", category: "趣味・娯楽" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.id).toBe(draft.id);
		expect(body.status).toBe("draft");
		expect(body.version).toBe(2);
		expect(body.topic).toBe("下書きに主題を追加");
		expect(body.category).toBe("趣味・娯楽");
		// 未指定フィールドは現行値のまま(raw_text・participants既定)
		expect(body.raw_text).toBe(draft.raw_text);
		expect(body.participants).toEqual({ min: 2, max: 2, includes_owner: true });
	});

	it('status:"active"+必須字段でactive化・200・expires_at計算・version+1', async () => {
		const accessToken = await registerUser("patch-activate");
		const draft = await createDraft(accessToken);
		const before = Date.now();
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active", form: "connection", topic: "有効化する学習仲間" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("active");
		expect(body.version).toBe(2);
		expect(body.form).toBe("connection");
		expect(body.topic).toBe("有効化する学習仲間");
		// 期限はactive化時刻+30日(つながりの既定・docs/05 §2.2)
		expect(expiresNear(body, before + 30 * MS_PER_DAY)).toBe(true);
	});

	it("機会draftに保存済みのexpires_atはactive化後もその値が使われる", async () => {
		const accessToken = await registerUser("patch-activate-stored");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const stored = new Date(start.getTime() + 5 * 3_600_000);
		const draft = await createDraft(accessToken, {
			form: "occasion",
			topic: "朝市めぐり",
			time: { start: start.toISOString(), end: null },
			expires_at: stored.toISOString(),
		});
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("active");
		// 検証済みの保存値が最優先で使われる(docs/05 §2.2: 明示値>保存値>既定)
		expect(body.expires_at).toBe(stored.toISOString());
	});

	it('status:"active"+expires_in_days=7のつながりactive化はexpires_at=now+7日', async () => {
		const accessToken = await registerUser("patch-activate-7d");
		const draft = await createDraft(accessToken);
		const before = Date.now();
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{
				status: "active",
				form: "connection",
				topic: "1週間だけの学習仲間",
				expires_in_days: 7,
			},
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("active");
		// 期限の選択は預ける時(active化)に確定するためactive化では有効
		expect(expiresNear(body, before + 7 * MS_PER_DAY)).toBe(true);
	});

	it("draftままでのexpires_at指定はその値が格納される(status維持・docs/05 §3.2)", async () => {
		const accessToken = await registerUser("patch-draft-expiry");
		const draft = await createDraft(accessToken);
		const expiresAt = new Date(Date.now() + MS_PER_DAY).toISOString();
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ expires_at: expiresAt },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("draft");
		expect(body.version).toBe(2);
		expect(body.expires_at).toBe(expiresAt);
	});

	it("draftままでのexpires_in_days指定は400・details.reasonsにexpires_choice_on_draft", async () => {
		const accessToken = await registerUser("patch-draft-expiry");
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ topic: "主題だけ変える", expires_in_days: 30 },
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["expires_choice_on_draft"]);
		// 更新は反映されない(draftのまま・version据え置き)
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, draft.id));
		expect(row?.status).toBe("draft");
		expect(row?.version).toBe(1);
		expect(row?.topic).toBeNull();
	});

	it("機会draftのactive化にexpires_in_days指定は400・details.reasonsにexpires_in_days_not_allowed", async () => {
		const accessToken = await registerUser("patch-activate-occ-days");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const draft = await createDraft(accessToken, {
			form: "occasion",
			topic: "夕方の散歩会",
			time: { start: start.toISOString(), end: null },
		});
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active", expires_in_days: 30 },
			accessToken,
		);
		// 機会の期限は開始時刻基準で確定するため期限日数の選択は受けない(黙って無視しない)
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["expires_in_days_not_allowed"]);
		// 行はdraftのまま・version据え置き
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, draft.id));
		expect(row?.status).toBe("draft");
		expect(row?.version).toBe(1);
	});

	it("activeが5件ある状態でのdraft→active化は422 ACTIVE_INTENT_LIMIT・draftはdraftのまま", async () => {
		const accessToken = await registerUser("patch-limit");
		for (let i = 0; i < 5; i++) {
			await createActiveConnection(accessToken, `参加中の学習仲間その${i + 1}`);
		}
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active", form: "connection", topic: "6件目の学習仲間" },
			accessToken,
		);
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("ACTIVE_INTENT_LIMIT");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, draft.id));
		expect(row?.status).toBe("draft");
		expect(row?.version).toBe(1);
	});

	it("19歳のdraft(飲酒の機会)のactive化は422 ALCOHOL_RESTRICTED・draftのまま(F7a設計 §4)", async () => {
		const accessToken = await registerUser(
			"patch-alcohol",
			birthDateYearsAgo(19),
		);
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{
				status: "active",
				form: "occasion",
				topic: "土曜の飲み会",
				time: {
					start: new Date(Date.now() + 2 * MS_PER_DAY).toISOString(),
					end: null,
				},
				alcohol_involved: true,
			},
			accessToken,
		);
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("ALCOHOL_RESTRICTED");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, draft.id));
		expect(row?.status).toBe("draft");
		expect(row?.version).toBe(1);
	});

	it("active化検証に違反するdraftのactive化は400・details.reasonsに理由コード", async () => {
		const accessToken = await registerUser("patch-activate-invalid");
		const draft = await createDraft(accessToken);
		const res = await patchJson(
			`/v1/intents/${draft.id}`,
			{ status: "active" },
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toContain("form_required");
		expect(body.error.details.reasons).toContain("topic_required");
	});
});

describe("PATCH /v1/intents/{id}・active状態(docs/05 §3.2: 可変フィールドは限定)", () => {
	it("topic変更は200・version+1・status維持", async () => {
		const accessToken = await registerUser("patch-active-topic");
		const created = await createActiveConnection(
			accessToken,
			"変更前の学習仲間",
		);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ topic: "変更後の学習仲間" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.topic).toBe("変更後の学習仲間");
		expect(body.status).toBe("active");
		expect(body.version).toBe(2);
	});

	it("notification_level=mutedは200・添付(participants)も変更できる", async () => {
		const accessToken = await registerUser("patch-active-attach");
		const created = await createActiveConnection(
			accessToken,
			"通知を消したい学習仲間",
		);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{
				notification_level: "muted",
				participants: { min: 3, max: 4, includes_owner: true },
			},
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.notification_level).toBe("muted");
		expect(body.participants).toEqual({ min: 3, max: 4, includes_owner: true });
		expect(body.version).toBe(2);
	});

	it("form・raw_text・status・expires_atの指定は400・details.reasonsにfield_not_allowed", async () => {
		const accessToken = await registerUser("patch-active-denied");
		const created = await createActiveConnection(
			accessToken,
			"変更できない学習仲間",
		);
		for (const patch of [
			{ form: "occasion" },
			{ raw_text: "入力文を書き換えたい" },
			{ status: "draft" },
			{ expires_in_days: 90 },
			{ expires_at: new Date(Date.now() + MS_PER_DAY).toISOString() },
			{ alcohol_involved: true },
			{ category: "音楽・芸術" },
		]) {
			const res = await patchJson(
				`/v1/intents/${created.id}`,
				patch,
				accessToken,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorResponse;
			expect(body.error.code).toBe("VALIDATION_FAILED");
			expect(body.error.details.reasons).toEqual(["field_not_allowed"]);
		}
		// いずれの試行でもversion・topicは変わらない
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.version).toBe(1);
		expect(row?.topic).toBe("変更できない学習仲間");
	});

	it("activeつながりへのtime指定は400・details.reasonsにstarts_at_not_allowed・行不変", async () => {
		const accessToken = await registerUser("patch-conn-time");
		const created = await createActiveConnection(
			accessToken,
			"時刻を持たない学習仲間",
		);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{
				time: {
					start: new Date(Date.now() + MS_PER_DAY).toISOString(),
					end: null,
				},
			},
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		// つながりIntentはstarts_at=null不変(docs/05 §2.2)
		expect(body.error.details.reasons).toEqual(["starts_at_not_allowed"]);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.startsAt).toBeNull();
		expect(row?.version).toBe(1);
	});

	it("他人のIntentへのPATCHは404・DB行は不変(存在を隠す)", async () => {
		const owner = await registerUser("patch-owner");
		const other = await registerUser("patch-other");
		const created = await createActiveConnection(
			owner,
			"他人は変えられない学習仲間",
		);
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ topic: "他人による主題書き換え" },
			other,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row?.topic).toBe("他人は変えられない学習仲間");
		expect(row?.version).toBe(1);
	});

	it("機会のstarts_atを過去へ変更は400・details.reasonsにstarts_at_out_of_range", async () => {
		const accessToken = await registerUser("patch-occ-past");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const occasionRes = await postJson(
			"/v1/intents",
			{
				raw_text: "土曜の朝に走りたい",
				form: "occasion",
				topic: "朝ラン会",
				time: { start: start.toISOString(), end: null },
			},
			{ Authorization: `Bearer ${accessToken}` },
		);
		expect(occasionRes.status).toBe(201);
		const occasion = (await occasionRes.json()) as IntentDTO;
		const res = await patchJson(
			`/v1/intents/${occasion.id}`,
			{
				time: {
					start: new Date(Date.now() - 3_600_000).toISOString(),
					end: null,
				},
			},
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.details.reasons).toContain("starts_at_out_of_range");
	});

	it("機会のstarts_atを現在のexpires_at超へ変更は400・details.reasonsにstarts_at_after_expires", async () => {
		const accessToken = await registerUser("patch-occ-over");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const occasionRes = await postJson(
			"/v1/intents",
			{
				raw_text: "日曜の朝に釣りに行きたい",
				form: "occasion",
				topic: "朝釣り会",
				time: { start: start.toISOString(), end: null },
			},
			{ Authorization: `Bearer ${accessToken}` },
		);
		expect(occasionRes.status).toBe(201);
		const occasion = (await occasionRes.json()) as IntentDTO;
		// 6日後はnow+7日以内だが、既定期限(start+3時間)より後
		const beyond = new Date(Date.now() + 6 * MS_PER_DAY);
		const res = await patchJson(
			`/v1/intents/${occasion.id}`,
			{ time: { start: beyond.toISOString(), end: null } },
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.details.reasons).toEqual(["starts_at_after_expires"]);
	});

	it("機会のstarts_atを現在のexpires_atより前に変更は200・expires_atは変わらない", async () => {
		const accessToken = await registerUser("patch-occ-ok");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const occasionRes = await postJson(
			"/v1/intents",
			{
				raw_text: "来週の夕方に散歩に行きたい",
				form: "occasion",
				topic: "夕方散歩",
				time: { start: start.toISOString(), end: null },
			},
			{ Authorization: `Bearer ${accessToken}` },
		);
		expect(occasionRes.status).toBe(201);
		const occasion = (await occasionRes.json()) as IntentDTO;
		const before = occasion.expires_at;
		const moved = new Date(Date.now() + MS_PER_DAY);
		const res = await patchJson(
			`/v1/intents/${occasion.id}`,
			{ time: { start: moved.toISOString(), end: null } },
			accessToken,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as IntentDTO;
		expect(body.time?.start).toBe(moved.toISOString());
		// activeではexpires_*は不変(既定期限=start+3時間のまま)
		expect(body.expires_at).toBe(before);
		expect(new Date(body.expires_at as string).getTime()).toBe(
			start.getTime() + OCCASION_DEFAULT_TTL_HOURS * 3_600_000,
		);
		expect(body.version).toBe(2);
	});
});

describe("PATCH /v1/intents/{id}・更新できない状態(docs/05 §3.2)", () => {
	it("paused行へのPATCHは400・details.reasonsにinvalid_status", async () => {
		const accessToken = await registerUser("patch-paused");
		const created = await createActiveConnection(
			accessToken,
			"一時停止する学習仲間",
		);
		// pause APIはTask 6のため、ここでは直接DBでpausedにする(ブリーフの指示どおり)
		await db
			.update(intents)
			.set({ status: "paused" })
			.where(eq(intents.id, created.id));
		const res = await patchJson(
			`/v1/intents/${created.id}`,
			{ topic: "一時停止中の主題変更" },
			accessToken,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["invalid_status"]);
	});

	it("空ボディ(更新フィールド無し)は400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("patch-empty");
		const created = await createActiveConnection(
			accessToken,
			"空更新の学習仲間",
		);
		const res = await patchJson(`/v1/intents/${created.id}`, {}, accessToken);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});
});

describe("PATCH・pause・resume共通のversion楽観ロック(docs/01 §16・05 §3.3)", () => {
	/** Intent行とその所有者ユーザー行を読み出す(楽観ロック試験の下準備) */
	const readRowAndOwner = async (
		intentId: string,
	): Promise<{
		row: typeof intents.$inferSelect;
		ownerId: string;
	}> => {
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, intentId));
		if (row === undefined) {
			throw new Error("作成直後のIntentが読み出せない");
		}
		const [owner] = await db
			.select()
			.from(users)
			.where(eq(users.id, row.userId));
		if (owner === undefined) {
			throw new Error("Intentの所有者が読み出せない");
		}
		return { row, ownerId: owner.id };
	};

	it("期待versionより行が新しい(並行更新済み)場合はversion_conflict・行は並行側の値のまま", async () => {
		const accessToken = await registerUser("optimistic-conflict");
		const created = await createActiveConnection(
			accessToken,
			"競合する学習仲間",
		);
		const { row, ownerId } = await readRowAndOwner(created.id);
		// ルートの「読み出し→更新」の間に並行更新が入った状態を直接DB操作で模擬する
		const concurrentVersion = row.version + 1;
		await db
			.update(intents)
			.set({ version: concurrentVersion, topic: "並行側の主題変更" })
			.where(eq(intents.id, created.id));
		// 古いversion(row)を持ったまま更新を試みる→0行→1回だけ再読込→version_conflict
		const result = await updateWithOptimisticLock(db, row, ownerId, {
			topic: "遅れた側の主題変更",
			version: concurrentVersion,
			updatedAt: new Date(),
		});
		expect(result.kind).toBe("version_conflict");
		// 行は並行側の値のまま(後勝ち上書きが起こらない・docs/01 §16)
		const [after] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(after?.version).toBe(concurrentVersion);
		expect(after?.topic).toBe("並行側の主題変更");
	});

	it("読み出し後に並行削除された場合はnot_found", async () => {
		const accessToken = await registerUser("optimistic-deleted");
		const created = await createActiveConnection(accessToken, "消える学習仲間");
		const { row, ownerId } = await readRowAndOwner(created.id);
		// 削除はアプリ層では子(match_events)を先に消す(docs/05 §2.5)。直接DB操作での
		// 模擬も同じ順序にする(FKがintentsを参照するため子の先行削除が必須)
		await db
			.delete(matchEvents)
			.where(eq(matchEvents.sourceIntentId, created.id));
		await db.delete(intents).where(eq(intents.id, created.id));
		const result = await updateWithOptimisticLock(db, row, ownerId, {
			topic: "反映されない主題変更",
			version: row.version + 1,
			updatedAt: new Date(),
		});
		expect(result.kind).toBe("not_found");
	});

	it("期待versionが一致する更新はok・version+1の行を返す(通常経路)", async () => {
		const accessToken = await registerUser("optimistic-ok");
		const created = await createActiveConnection(
			accessToken,
			"通常更新の学習仲間",
		);
		const { row, ownerId } = await readRowAndOwner(created.id);
		const result = await updateWithOptimisticLock(db, row, ownerId, {
			topic: "通常更新後の学習仲間",
			version: row.version + 1,
			updatedAt: new Date(),
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			throw new Error("通常更新が失敗した");
		}
		expect(result.row.version).toBe(row.version + 1);
		expect(result.row.topic).toBe("通常更新後の学習仲間");
	});
});

describe("DELETE /v1/intents/{id}(削除・docs/05 §3.1・§3.2)", () => {
	it("自分のIntentは204・その後のGETは404・一覧からも消える", async () => {
		const accessToken = await registerUser("delete-owner");
		const created = await createActiveConnection(
			accessToken,
			"削除対象の学習仲間",
		);
		const res = await deleteReq(`/v1/intents/${created.id}`, accessToken);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		const getRes = await getReq(`/v1/intents/${created.id}`, accessToken);
		expect(getRes.status).toBe(404);
		const listRes = await getReq("/v1/intents", accessToken);
		const list = (await listRes.json()) as IntentsListResponse;
		expect(list.items).toHaveLength(0);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row).toBeUndefined();
	});

	it("他人のIntentの削除は404・行は残る(存在を隠す)", async () => {
		const owner = await registerUser("del-owner");
		const other = await registerUser("del-other");
		const created = await createActiveConnection(
			owner,
			"他人は消せない学習仲間",
		);
		const res = await deleteReq(`/v1/intents/${created.id}`, other);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row).toBeDefined();
	});

	it("存在しないidの削除は404", async () => {
		const accessToken = await registerUser("delete-missing");
		const res = await deleteReq(`/v1/intents/${ulid()}`, accessToken);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("未認証の削除は401 UNAUTHORIZED", async () => {
		const res = await deleteReq(`/v1/intents/${ulid()}`, "");
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("DELETE・PATCH /v1/intents/{id}: 進行中の提案の取り消し(docs/01 §8・docs/05 §2.5・§3.2)", () => {
	/** 相手ユーザーとそのactiveなつながりIntentを直接INSERTする */
	const insertPeer = async (): Promise<{
		userId: string;
		intentId: string;
	}> => {
		const userId = ulid();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			authProvider: "google",
			authSubject: `del-peer-${userId}`,
			actorType: "individual",
			displayName: "相手",
			bio: "",
			birthDate: "1990-01-01",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		const intentId = ulid();
		await db.insert(intents).values({
			id: intentId,
			userId,
			form: "connection",
			topic: "相手の主題",
			rawText: "相手の生テキスト",
			participantsMin: 2,
			participantsMax: 3,
			participantsIncludesOwner: true,
			hardConstraints: [],
			softConstraints: [],
			negativeConstraints: [],
			visibility: "hidden_until_match",
			notificationLevel: "proposals_only",
			alcoholInvolved: false,
			status: "active",
			version: 1,
			expiresAt: new Date(Date.now() + 30 * MS_PER_DAY),
			createdAt: now,
			updatedAt: now,
		});
		return { userId, intentId };
	};

	/** 2者のLATCH・members・proposal_historyを直接INSERTする */
	const insertLatchOf = async (
		mine: { userId: string; intentId: string },
		peer: { userId: string; intentId: string },
		status: "candidate" | "proposed" | "matched",
	): Promise<string> => {
		const id = ulid();
		const now = new Date();
		await db.insert(latches).values({
			id,
			form: "connection",
			intentIds: [mine.intentId, peer.intentId],
			proposal: {
				form: "connection",
				topic: "主題",
				time_window: null,
				region_name: null,
				participants: { min: 2, max: 3 },
				budget: null,
			},
			score: 0.9,
			status,
			responseDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
			expiresAt: new Date(Date.now() + 30 * MS_PER_DAY),
			lastMessageAt: now,
			completedAt: null,
			proposedAt: status === "candidate" ? null : now,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(latchMembers).values([
			{ latchId: id, userId: mine.userId },
			{ latchId: id, userId: peer.userId },
		]);
		const [low, high] =
			mine.userId < peer.userId
				? [mine.userId, peer.userId]
				: [peer.userId, mine.userId];
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: id,
			outcome: status === "matched" ? "matched" : "proposed",
			createdAt: now,
			updatedAt: now,
		});
		return id;
	};

	const setup = async (label: string) => {
		const accessToken = await registerUser(label);
		const created = await createActiveConnection(accessToken, `${label}の主題`);
		const [row] = await db
			.select({ userId: intents.userId })
			.from(intents)
			.where(eq(intents.id, created.id));
		const mine = { userId: row?.userId ?? "", intentId: created.id };
		return { accessToken, mine, peer: await insertPeer() };
	};

	const latchOf = async (id: string) => {
		const [row] = await db.select().from(latches).where(eq(latches.id, id));
		return row;
	};

	it("proposedのLATCHはcancelledになり、参加者全員にclosed通知・historyはexpired", async () => {
		const { accessToken, mine, peer } = await setup("del-proposed");
		const latchId = await insertLatchOf(mine, peer, "proposed");
		const res = await deleteReq(`/v1/intents/${mine.intentId}`, accessToken);
		expect(res.status).toBe(204);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		const notes = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, latchId));
		expect(notes.map((n) => n.userId).sort()).toEqual(
			[mine.userId, peer.userId].sort(),
		);
		expect(notes.every((n) => n.type === "closed")).toBe(true);
		const [hist] = await db
			.select()
			.from(proposalHistory)
			.where(eq(proposalHistory.latchId, latchId));
		// システムの都合(削除・条件変更)で閉じた提案は履歴を消費しない(オーナー裁定 2026-10-20)
		expect(hist).toBeUndefined();
	});

	it("matchedのLATCHは変化しない", async () => {
		const { accessToken, mine, peer } = await setup("del-matched");
		const latchId = await insertLatchOf(mine, peer, "matched");
		const res = await deleteReq(`/v1/intents/${mine.intentId}`, accessToken);
		expect(res.status).toBe(204);
		expect((await latchOf(latchId))?.status).toBe("matched");
		const notes = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, latchId));
		expect(notes).toHaveLength(0);
	});

	it("PATCHでtopicを変えると進行中のproposedはcancelledになり、相手にclosed通知(01 §8のHard Constraintの変化)", async () => {
		const { accessToken, mine, peer } = await setup("patch-topic");
		const latchId = await insertLatchOf(mine, peer, "proposed");
		const matchedId = await insertLatchOf(mine, await insertPeer(), "matched");
		const res = await patchJson(
			`/v1/intents/${mine.intentId}`,
			{ topic: "変更後の主題" },
			accessToken,
		);
		expect(res.status).toBe(200);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		const notes = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, latchId));
		expect(
			notes.some((n) => n.userId === peer.userId && n.type === "closed"),
		).toBe(true);
		const [hist] = await db
			.select()
			.from(proposalHistory)
			.where(eq(proposalHistory.latchId, latchId));
		// システムの都合(削除・条件変更)で閉じた提案は履歴を消費しない(オーナー裁定 2026-10-20)
		expect(hist).toBeUndefined();
		// matchedは変えない
		expect((await latchOf(matchedId))?.status).toBe("matched");
	});

	it("PATCHでnotification_levelだけを変えても進行中のproposedは変わらない", async () => {
		const { accessToken, mine, peer } = await setup("patch-notify");
		const latchId = await insertLatchOf(mine, peer, "proposed");
		const res = await patchJson(
			`/v1/intents/${mine.intentId}`,
			{ notification_level: "muted" },
			accessToken,
		);
		expect(res.status).toBe(200);
		expect((await latchOf(latchId))?.status).toBe("proposed");
		const notes = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, latchId));
		expect(notes).toHaveLength(0);
	});

	it("PATCHで意味フィールドを変えると30分の再評価抑制を解除する(last_evaluated_atをnullへ・オーナー裁定 2026-10-20)", async () => {
		const { accessToken, mine } = await setup("patch-reeval");
		const evaluatedAt = new Date(Date.UTC(2026, 0, 1));
		await db
			.update(intents)
			.set({ lastEvaluatedAt: evaluatedAt })
			.where(eq(intents.id, mine.intentId));
		const res = await patchJson(
			`/v1/intents/${mine.intentId}`,
			{ topic: "変更後の主題" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const [row] = await db
			.select({ lastEvaluatedAt: intents.lastEvaluatedAt })
			.from(intents)
			.where(eq(intents.id, mine.intentId));
		expect(row?.lastEvaluatedAt).toBeNull();
	});

	it("PATCHでnotification_levelだけを変えても再評価抑制は解除しない", async () => {
		const { accessToken, mine } = await setup("patch-reeval-notify");
		const evaluatedAt = new Date(Date.UTC(2026, 0, 1));
		await db
			.update(intents)
			.set({ lastEvaluatedAt: evaluatedAt })
			.where(eq(intents.id, mine.intentId));
		const res = await patchJson(
			`/v1/intents/${mine.intentId}`,
			{ notification_level: "muted" },
			accessToken,
		);
		expect(res.status).toBe(200);
		const [row] = await db
			.select({ lastEvaluatedAt: intents.lastEvaluatedAt })
			.from(intents)
			.where(eq(intents.id, mine.intentId));
		expect(row?.lastEvaluatedAt?.getTime()).toBe(evaluatedAt.getTime());
	});

	it("グループ提案{A,B,C}の進行中にAが削除すると、Aを含む評価済み集合は提案されず、Aを含まない集合は提案され得る(F4b設計 §3.5)", async () => {
		const { accessToken, mine, peer: b } = await setup("del-group-next");
		const c = await insertPeer();
		const d = await insertPeer();
		// 3人集合に収まる人数範囲へ揃える(版は変えない)
		const all = [mine, b, c, d];
		await db
			.update(intents)
			.set({ participantsMax: 4 })
			.where(
				inArray(
					intents.id,
					all.map((m) => m.intentId),
				),
			);
		const now = new Date();
		const latchId = ulid();
		const trio = [mine, b, c];
		await db.insert(latches).values({
			id: latchId,
			form: "connection",
			intentIds: trio.map((m) => m.intentId).sort(),
			proposal: {
				form: "connection",
				topic: "主題",
				time_window: null,
				region_name: null,
				participants: { min: 3, max: 4 },
				budget: null,
			},
			score: 0.9,
			status: "proposed",
			responseDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
			expiresAt: new Date(Date.now() + 30 * MS_PER_DAY),
			lastMessageAt: now,
			completedAt: null,
			proposedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await db
			.insert(latchMembers)
			.values(trio.map((m) => ({ latchId, userId: m.userId })));
		for (const [p, q] of [
			[mine, b],
			[mine, c],
			[b, c],
		] as const) {
			const [low, high] =
				p.userId < q.userId ? [p.userId, q.userId] : [q.userId, p.userId];
			await db.insert(proposalHistory).values({
				id: ulid(),
				userLow: low,
				userHigh: high,
				latchId,
				outcome: "proposed",
				createdAt: now,
				updatedAt: now,
			});
		}
		/** 評価済みのグループ候補を配置する(dedup_keyは現行versionで作る) */
		const insertCandidate = async (
			members: { intentId: string }[],
			score: number,
		) => {
			const rows = await db
				.select({ id: intents.id, version: intents.version })
				.from(intents)
				.where(
					inArray(
						intents.id,
						members.map((m) => m.intentId),
					),
				);
			const sorted = rows.sort((p, q) => (p.id < q.id ? -1 : 1));
			await db.insert(groupCandidates).values({
				id: ulid(),
				intentIds: sorted.map((r) => r.id),
				dedupKey: sorted.map((r) => `${r.id}@${r.version}`).join(","),
				aggregateScore: score,
				prevAggregateScore: null,
				status: "candidate",
				createdAt: now,
			});
		};
		// Aを含む集合を上位に置く(修正前はこちらが提案されていた)
		await insertCandidate([mine, b, d], 0.95);
		await insertCandidate([b, c, d], 0.8);

		const res = await deleteReq(`/v1/intents/${mine.intentId}`, accessToken);
		expect(res.status).toBe(204);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		const rest = (await db.select().from(latches).all()).filter(
			(l) =>
				l.id !== latchId &&
				l.intentIds.some((id) => all.some((m) => m.intentId === id)),
		);
		// 削除したIntentを含むLATCHは作られない
		expect(rest.some((l) => l.intentIds.includes(mine.intentId))).toBe(false);
		// Aを含まない評価済み集合{B,C,D}は提案される
		expect(rest).toHaveLength(1);
		expect(rest[0]?.status).toBe("proposed");
		expect([...(rest[0]?.intentIds ?? [])].sort()).toEqual(
			[b, c, d].map((m) => m.intentId).sort(),
		);
		// 削除した本人には新しい提案の通知が来ない
		const mineProposals = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, mine.userId));
		expect(mineProposals.every((n) => n.type !== "proposal")).toBe(true);
	});

	it("保留(candidate)のLATCHもcancelledになり、通知は作られない", async () => {
		const { accessToken, mine, peer } = await setup("del-candidate");
		const latchId = await insertLatchOf(mine, peer, "candidate");
		const res = await deleteReq(`/v1/intents/${mine.intentId}`, accessToken);
		expect(res.status).toBe(204);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		const notes = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, latchId));
		expect(notes).toHaveLength(0);
	});
});
