/**
 * Intent API(POST /v1/intents/parse・POST /v1/intents)の統合試験。
 * docs/05 §3.2(エンドポイント)・§3.3(parse応答・IntentDTO)・§2.2(active化検証・期限)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得する(users-api.test.tsと同一パターン)。
 * IdPトークンはコミット済みテスト鍵(tests/fixtures/test-idp-private.jwk)で署名し、
 * Worker側はvitest.config.tsが注入するLATCH_TEST_IDP_JWKSバインディングで検証する(docs/04 §4)。
 */

import { env, SELF } from "cloudflare:test";
import {
	type IntentDTO,
	OCCASION_DEFAULT_TTL_HOURS,
	type ParseIntentResponse,
} from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { intents } from "../src/db/schema";
import { MS_PER_DAY } from "../src/intents/expiry";
import { toIntentDto } from "../src/routes/intents";
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

/** docs/05 §3.1のエラー応答の形状(active化検証はdetails.reasonsに理由コードを載せる) */
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

/** POST /v1/intents/parseを呼ぶ */
const postParse = (accessToken: string, body: unknown): Promise<Response> =>
	postJson("/v1/intents/parse", body, {
		Authorization: `Bearer ${accessToken}`,
	});

/** POST /v1/intentsを呼ぶ */
const postIntents = (accessToken: string, body: unknown): Promise<Response> =>
	postJson("/v1/intents", body, { Authorization: `Bearer ${accessToken}` });

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

describe("POST /v1/intents/parse(docs/05 §3.2・§3.3: 構造化プレビュー・保存しない)", () => {
	it("つながりと読める文は200・form=connection・topic=先頭文・expires_at_options 3件", async () => {
		const accessToken = await registerUser("parse");
		const res = await postParse(accessToken, {
			raw_text: "来月から個人開発仲間を探しています",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ParseIntentResponse;
		// stubの規則ベース判定(07 §3): 時刻語・日付語なし→つながり
		expect(body.form).toBe("connection");
		expect(body.topic).toBe("来月から個人開発仲間を探しています");
		expect(body.category).toBeNull();
		expect(body.time).toBeNull();
		// parseは地域を解決しない(ユーザーが添付で確定させる)
		expect(body.geo).toBeNull();
		// includes_ownerはtrue固定
		expect(body.participants).toEqual({ min: 2, max: 2, includes_owner: true });
		expect(body.budget).toBeNull();
		expect(body.alcohol_involved).toBe(false);
		expect(body.warnings).toEqual([]);
		// つながりは期限選択肢3件(now+7/30/90日)
		expect(body.expires_at_options).toHaveLength(3);
	});

	it("raw_text空は400 VALIDATION_FAILED", async () => {
		const accessToken = await registerUser("parse-empty");
		const res = await postParse(accessToken, { raw_text: "" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("未認証は401 UNAUTHORIZED", async () => {
		const res = await postJson("/v1/intents/parse", {
			raw_text: "認証なしの入力",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

describe("POST /v1/intents・active作成(docs/05 §3.2・§2.2)", () => {
	it("つながり・主題のみで201・DTOが保存値と一致(version=1・hidden_until_match・expires_at=now+30日)", async () => {
		const accessToken = await registerUser("create-conn");
		const before = Date.now();
		const res = await postIntents(
			accessToken,
			connectionBody("週末にランニング仲間を探しています"),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		expect(body.id).toHaveLength(26);
		expect(body.form).toBe("connection");
		expect(body.topic).toBe("週末にランニング仲間を探しています");
		expect(body.category).toBeNull();
		expect(body.status).toBe("active");
		expect(body.version).toBe(1);
		// visibilityはリクエストで受けずhidden_until_match固定(docs/01 §21)
		expect(body.visibility).toBe("hidden_until_match");
		// スキーマ既定値(docs/05 §3.2)
		expect(body.participants).toEqual({ min: 2, max: 2, includes_owner: true });
		expect(body.hard_constraints).toEqual([]);
		expect(body.soft_constraints).toEqual([]);
		expect(body.negative_constraints).toEqual([]);
		expect(body.notification_level).toBe("proposals_only");
		expect(body.alcohol_involved).toBe(false);
		expect(body.time).toBeNull();
		expect(body.geo).toBeNull();
		expect(body.budget).toBeNull();
		// 期限はactive化時刻+30日(つながりの既定・docs/05 §2.2)
		expect(expiresNear(body, before + 30 * MS_PER_DAY)).toBe(true);
		// 応答DTOがD1の保存値と一致(toIntentDtoが保存行から組み立てられている)
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, body.id));
		expect(row).toBeDefined();
		expect(body).toEqual(toIntentDto(row as typeof intents.$inferSelect));
	});

	it("つながり・expires_in_days=7でexpires_at=now+7日・=90でnow+90日", async () => {
		const before = Date.now();
		const accessToken7 = await registerUser("expiry7");
		const res7 = await postIntents(
			accessToken7,
			connectionBody("カフェで話す友達が欲しい", { expires_in_days: 7 }),
		);
		expect(res7.status).toBe(201);
		const body7 = (await res7.json()) as IntentDTO;
		expect(expiresNear(body7, before + 7 * MS_PER_DAY)).toBe(true);

		const accessToken90 = await registerUser("expiry90");
		const res90 = await postIntents(
			accessToken90,
			connectionBody("写真撮影の仲間が欲しい", { expires_in_days: 90 }),
		);
		expect(res90.status).toBe(201);
		const body90 = (await res90.json()) as IntentDTO;
		expect(expiresNear(body90, before + 90 * MS_PER_DAY)).toBe(true);
	});

	it("機会・time.start=now+2日でexpires_at=start+3時間(既定)", async () => {
		const accessToken = await registerUser("create-occ");
		const start = new Date(Date.now() + 2 * MS_PER_DAY).toISOString();
		const res = await postIntents(accessToken, {
			raw_text: "土曜の14時にボルダリングへ行きたい",
			form: "occasion",
			topic: "ボルダリング仲間募集",
			time: { start, end: null },
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		expect(body.form).toBe("occasion");
		expect(body.time).toEqual({ start, end: null });
		// 機会の既定期限はstart+3時間(startはリクエスト値そのままなので厳密一致で検証できる)
		expect(new Date(body.expires_at as string).getTime()).toBe(
			new Date(start).getTime() + OCCASION_DEFAULT_TTL_HOURS * 3_600_000,
		);
	});

	it("機会・明示expires_atはその値が保存される", async () => {
		const accessToken = await registerUser("create-occ-explicit");
		const start = new Date(Date.now() + 2 * MS_PER_DAY);
		const expiresAt = new Date(start.getTime() + 5 * 3_600_000);
		const res = await postIntents(accessToken, {
			raw_text: "日曜の10時に朝市へ行きたい",
			form: "occasion",
			topic: "朝市めぐり",
			time: { start: start.toISOString(), end: null },
			expires_at: expiresAt.toISOString(),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		// startより後の明示値は検証を通ってそのまま保存される(docs/05 §2.2)
		expect(body.expires_at).toBe(expiresAt.toISOString());
	});
});

describe("POST /v1/intents・draft作成(docs/05 §3.2: 意味検証なしで保存)", () => {
	it("raw_textのみのdraftは201・form/topic/expires_at=null・status=draft", async () => {
		const accessToken = await registerUser("draft-min");
		const res = await postIntents(accessToken, {
			raw_text: "まだぼんやりだけど、いつかサーフィンを始めたい",
			status: "draft",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("draft");
		expect(body.form).toBeNull();
		expect(body.topic).toBeNull();
		expect(body.expires_at).toBeNull();
		expect(body.version).toBe(1);
		expect(body.visibility).toBe("hidden_until_match");
	});

	it("draftへのexpires_in_days指定は400・details.reasonsにexpires_choice_on_draft", async () => {
		const accessToken = await registerUser("draft-expiry-days");
		const res = await postIntents(accessToken, {
			raw_text: "期限の選択は預ける時に確定させる",
			status: "draft",
			expires_in_days: 30,
		});
		// draftでは期限の選択(expires_in_days)を受けない・作成もされない
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["expires_choice_on_draft"]);
	});

	it("draft作成時に明示expires_atを指定するとその値が保存される", async () => {
		const accessToken = await registerUser("draft-expires-at");
		const expiresAt = new Date(Date.now() + MS_PER_DAY).toISOString();
		const res = await postIntents(accessToken, {
			raw_text: "いつか行きたい場所のメモ",
			status: "draft",
			expires_at: expiresAt,
		});
		// draft保存ではexpires_at格納可(null可と同格・docs/05 §2.2)
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		expect(body.expires_at).toBe(expiresAt);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, body.id));
		expect(row?.expiresAt?.toISOString()).toBe(expiresAt);
	});

	it("form/topic/過去starts_at付きdraftは意味検証されずその値が保存される", async () => {
		const accessToken = await registerUser("draft-full");
		const past = new Date(Date.now() - MS_PER_DAY).toISOString();
		const res = await postIntents(accessToken, {
			raw_text: "昨日行けなかった飲み会のリベンジをしたい",
			status: "draft",
			form: "connection",
			topic: "飲み会リベンジ",
			time: { start: past, end: null },
			alcohol_involved: true,
		});
		// activeならstarts_at_not_allowed等になる組合せだが、draftは検証なしで保存できる
		expect(res.status).toBe(201);
		const body = (await res.json()) as IntentDTO;
		expect(body.status).toBe("draft");
		expect(body.form).toBe("connection");
		expect(body.topic).toBe("飲み会リベンジ");
		expect(body.time?.start).toBe(past);
		expect(body.alcohol_involved).toBe(true);
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, body.id));
		expect(row?.startsAt?.toISOString()).toBe(past);
		expect(row?.expiresAt).toBeNull();
	});
});

describe("POST /v1/intents・active作成の検証(docs/05 §2.2の理由コード)", () => {
	it("つながりにtimeを付けたactive作成は400・details.reasonsにstarts_at_not_allowed", async () => {
		const accessToken = await registerUser("reject-conn-time");
		const res = await postIntents(
			accessToken,
			connectionBody("ランニング仲間を探しています", {
				time: {
					start: new Date(Date.now() + MS_PER_DAY).toISOString(),
					end: null,
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toContain("starts_at_not_allowed");
	});

	it("topic無しのactive作成は400・details.reasonsにtopic_required", async () => {
		const accessToken = await registerUser("reject-no-topic");
		const res = await postIntents(accessToken, {
			raw_text: "誰か話し相手になってほしい",
			form: "connection",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toContain("topic_required");
	});

	it("機会にstarts_at(time)無しのactive作成は400・details.reasonsにstarts_at_required", async () => {
		const accessToken = await registerUser("reject-occ-nostart");
		const res = await postIntents(accessToken, {
			raw_text: "そのうちキャンプに行きたい",
			form: "occasion",
			topic: "キャンプ仲間",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toContain("starts_at_required");
	});

	it("機会active作成にexpires_in_days指定は400・details.reasonsにexpires_in_days_not_allowed", async () => {
		const accessToken = await registerUser("reject-occ-expiry-days");
		const start = new Date(Date.now() + 2 * MS_PER_DAY).toISOString();
		const res = await postIntents(accessToken, {
			raw_text: "土曜の10時に朝市へ行きたい",
			form: "occasion",
			topic: "朝市めぐり",
			time: { start, end: null },
			expires_in_days: 30,
		});
		// 機会の期限は開始時刻基準で確定するため期限日数の選択は受けない(黙って無視しない)
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["expires_in_days_not_allowed"]);
	});

	it("starts_atが過去の機会active作成は400・details.reasonsにstarts_at_out_of_range", async () => {
		const accessToken = await registerUser("reject-occ-past");
		const res = await postIntents(accessToken, {
			raw_text: "昨日のライブについて語りたい",
			form: "occasion",
			topic: "ライブの感想会",
			time: {
				start: new Date(Date.now() - 3_600_000).toISOString(),
				end: null,
			},
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toContain("starts_at_out_of_range");
	});
});

describe("POST /v1/intents・入力検証と上限(docs/05 §3.1・§2.2)", () => {
	it("topic 41字は400 VALIDATION_FAILED(Zodの上限40字)", async () => {
		const accessToken = await registerUser("reject-topic-long");
		const res = await postIntents(accessToken, connectionBody("あ".repeat(41)));
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		// Zodのリクエスト検証のためdetails.reasonsは付かない(active化検証の失敗ではない)
		expect(body.error.details.reasons).toBeUndefined();
	});

	it("activeが5件ある状態での6件目のactive作成は422 ACTIVE_INTENT_LIMIT・draftは作れる", async () => {
		const accessToken = await registerUser("limit");
		for (let i = 0; i < 5; i++) {
			const res = await postIntents(
				accessToken,
				connectionBody(`継続的な学習仲間その${i + 1}`),
			);
			expect(res.status).toBe(201);
		}
		const sixth = await postIntents(
			accessToken,
			connectionBody("6件目の学習仲間"),
		);
		expect(sixth.status).toBe(422);
		const body = (await sixth.json()) as ErrorResponse;
		expect(body.error.code).toBe("ACTIVE_INTENT_LIMIT");
		// draftは参加中(active)数に数えないため作成できる
		const draft = await postIntents(accessToken, {
			raw_text: "迷い中の下書き",
			status: "draft",
		});
		expect(draft.status).toBe(201);
	});

	it("未認証の作成は401 UNAUTHORIZED", async () => {
		const res = await postJson("/v1/intents", {
			raw_text: "認証なしの作成",
			form: "connection",
			topic: "未認証テスト",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});

/** 飲酒を含む機会Intentのactive作成ボディ(2日後開始) */
const alcoholOccasionBody = (
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	raw_text: "土曜の夜に一緒に飲みに行きたい",
	form: "occasion",
	topic: "土曜の飲み会",
	time: {
		start: new Date(Date.now() + 2 * MS_PER_DAY).toISOString(),
		end: null,
	},
	alcohol_involved: true,
	...extra,
});

describe("POST /v1/intents・飲酒年齢(F7a設計 §4・docs/08 §8)", () => {
	it("19歳が飲酒の機会Intentをactiveで作ると422 ALCOHOL_RESTRICTED・draftは201", async () => {
		const accessToken = await registerUser("alc-19", birthDateYearsAgo(19));
		const res = await postIntents(accessToken, alcoholOccasionBody());
		expect(res.status).toBe(422);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("ALCOHOL_RESTRICTED");
		const draft = await postIntents(
			accessToken,
			alcoholOccasionBody({ status: "draft" }),
		);
		expect(draft.status).toBe(201);
	});

	it("誕生日当日に満20歳なら201・前日なら422", async () => {
		const okToken = await registerUser("alc-20", birthDateYearsAgo(20));
		expect((await postIntents(okToken, alcoholOccasionBody())).status).toBe(
			201,
		);
		// 20年前の同日の翌日生まれ=あと1日で満20歳
		const next = new Date(`${birthDateYearsAgo(20)}T00:00:00Z`);
		next.setUTCDate(next.getUTCDate() + 1);
		const ngToken = await registerUser(
			"alc-eve",
			next.toISOString().slice(0, 10),
		);
		const res = await postIntents(ngToken, alcoholOccasionBody());
		expect(res.status).toBe(422);
		expect(((await res.json()) as ErrorResponse).error.code).toBe(
			"ALCOHOL_RESTRICTED",
		);
	});

	it("飲酒なしの機会は19歳でも201", async () => {
		const accessToken = await registerUser("alc-none", birthDateYearsAgo(19));
		const res = await postIntents(
			accessToken,
			alcoholOccasionBody({ alcohol_involved: false }),
		);
		expect(res.status).toBe(201);
	});

	it("activeが5件ある19歳の飲酒機会は上限より先にALCOHOL_RESTRICTED", async () => {
		const accessToken = await registerUser("alc-limit", birthDateYearsAgo(19));
		for (let i = 0; i < 5; i++) {
			expect(
				(await postIntents(accessToken, connectionBody(`学習仲間その${i + 1}`)))
					.status,
			).toBe(201);
		}
		const res = await postIntents(accessToken, alcoholOccasionBody());
		expect(res.status).toBe(422);
		expect(((await res.json()) as ErrorResponse).error.code).toBe(
			"ALCOHOL_RESTRICTED",
		);
	});
});
