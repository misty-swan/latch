/**
 * E2E用ヘルパー(テスト鍵モードのIdPトークン署名・docs/04 §4+テストユーザー登録)。
 * PlaywrightのspecはNode(workerd外)で実行されるため、コミット済みテスト鍵の
 * 秘密JWKを実FSから読んでjoseで署名できる(統合試験の?raw読み込みとは逆の前提)。
 * Worker側は .dev.vars の LATCH_TEST_IDP_JWKS(prepare-dev-vars.mjsが生成)で
 * 同じ鍵の公開JWKSを検証する。テスト専用の値であり、prodではassertEnvSafetyが
 * 同じ変数の設定自体を拒否する(docs/10 §2)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { LatchDTO, LatchResponseValue } from "@latch/shared";
import { type APIRequestContext, expect } from "@playwright/test";
import { generateKeyPair, importJWK, SignJWT } from "jose";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";

/** コミット済みテスト鍵の秘密JWK(Task 5の生成物・E2E専用に署名へ使う) */
const privateJwk = JSON.parse(
	readFileSync(
		path.join(import.meta.dirname, "../tests/fixtures/test-idp-private.jwk"),
		"utf8",
	),
) as { kid: string } & Record<string, unknown>;

/** 署名鍵の遅延生成(spec実行ごとに1回) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/**
 * テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud)。
 * expは現在時刻+600秒=有効
 */
export const signIdpToken = async (sub: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(await signingKey());
};

/**
 * でっち上げトークン(鍵不一致): iss/audは正しいが別鍵で署名したIdPトークン。
 * 署名検証が実際に鍵を確認していることのE2E確認用(docs/04 §4)
 */
export const signForeignIdpToken = async (sub: string): Promise<string> => {
	const { privateKey } = await generateKeyPair("RS256", {
		modulusLength: 2048,
	});
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub })
		.setProtectedHeader({ alg: "RS256", kid: "forged-key" })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(privateKey);
};

/** registerUserの応答(docs/05 §3.3のUserDTO+アクセストークン) */
export interface RegisteredUser {
	access_token: string;
	user: {
		id: string;
		display_name: string;
		bio: string;
		has_icon: boolean;
	};
}

/**
 * テストユーザーを1人登録する(docs/05 §3.2のauth/token→users登録フローを
 * 1メソッドに束ねた共通ヘルパー・F3以降のspecでも使う)。subは毎回ランダム生成
 * (ローカルD1は実行間で永続するための汚染回避・docs/04 §4)。birth_dateは
 * 18歳以上になる固定値(未成年系の検証はauth.spec.tsが専用の値で担う)
 */
export const registerUser = async (
	request: APIRequestContext,
	displayName = "E2Eテストユーザー",
): Promise<RegisteredUser> => {
	const tokenRes = await request.post("/v1/auth/token", {
		data: {
			provider: "google",
			idp_token: await signIdpToken(`e2e-${crypto.randomUUID()}`),
		},
	});
	expect(tokenRes.status()).toBe(200);
	const token = (await tokenRes.json()) as { access_token: string };
	const registerRes = await request.post("/v1/users", {
		data: { display_name: displayName, birth_date: "2000-01-01", bio: "" },
		headers: { authorization: `Bearer ${token.access_token}` },
	});
	expect(registerRes.status()).toBe(201);
	const registered = (await registerRes.json()) as {
		access_token: string;
		user: RegisteredUser["user"];
	};
	return { access_token: registered.access_token, user: registered.user };
};

/**
 * 条件を満たすまで一定間隔でpredicateを再試行するポーラ(E2E用・docs/10 §3の
 * 実時間)。タイムアウト経過でも満たされなければ例外で失敗する。
 * パイプラインのキュー消費やCron発火の反映待ちに使う
 */
export const waitFor = async (
	predicate: () => Promise<boolean>,
	timeout: number,
	interval = 1_000,
): Promise<void> => {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (await predicate()) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(`waitForがtimeout(${timeout}ms)に達しました`);
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
};

/**
 * Cronを強制発火する(wrangler dev --test-scheduledが提供するGET /__scheduled)。
 * scheduledハンドラの完了を待って応答が返るため、返却後は毎分Cronの全走査
 * (期限切れ遷移・バックフィル等・docs/06 §2)の効果がD1へ反映済みである
 */
export const runCron = async (request: APIRequestContext): Promise<void> => {
	const res = await request.get("/__scheduled");
	expect(res.status(), "GET /__scheduled(Cron強制発火)").toBe(200);
};

/** Bearer認証ヘッダー(F4aのLATCH系ヘルパー共通) */
const bearer = (accessToken: string): Record<string, string> => ({
	authorization: `Bearer ${accessToken}`,
});

/** POST /v1/intentsの応答のうちLATCH系E2Eが使う欄(docs/05 §3.3のIntentDTO) */
export interface CreatedIntent {
	id: string;
	form: "connection" | "occasion" | null;
	status: string;
	version: number;
	expires_at: string | null;
}

/**
 * Intentを直接保存する(POST /v1/intents・status=activeの201を保証)。
 * bodyはdocs/05 §3.2のリクエストをそのまま渡す(form・topic・time・geo等)
 */
export const createIntent = async (
	request: APIRequestContext,
	accessToken: string,
	body: Record<string, unknown>,
): Promise<CreatedIntent> => {
	const res = await request.post("/v1/intents", {
		data: body,
		headers: bearer(accessToken),
	});
	expect(res.status(), `POST /v1/intents(${String(body.topic)})`).toBe(201);
	return (await res.json()) as CreatedIntent;
};

/** GET /v1/dev/latchesの1項目(F4a計画Task 17の観測契約) */
export interface DevLatchItem {
	id: string;
	form: string;
	status: string;
	intent_ids: string[];
	response_deadline: string;
	proposed_at: string | null;
	score: number;
}

/** 指定Intentを含むLATCHを観測APIで取得する(1ケースあたり少数のためlimit=50の1ページで足りる) */
export const listDevLatches = async (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
): Promise<DevLatchItem[]> => {
	const res = await request.get(
		`/v1/dev/latches?intent_id=${intentId}&limit=50`,
		{ headers: bearer(accessToken) },
	);
	expect(res.status(), "GET /v1/dev/latches").toBe(200);
	const body = (await res.json()) as { items: DevLatchItem[] };
	return body.items;
};

/**
 * 指定Intentを含み、matchを満たすLATCHが観測APIに現れるまで待って返す。
 * 提案化はペアのどちら側の評価でも起こり得る(後から作った側の評価で先にある側が
 * 候補になる・F4a設計 §3.1)ため、待つ条件はLATCHの出現そのものに置く
 */
export const waitForLatch = async (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
	match: (item: DevLatchItem) => boolean = () => true,
	timeout = 60_000,
): Promise<DevLatchItem> => {
	let found: DevLatchItem | undefined;
	await waitFor(
		async () => {
			found = (await listDevLatches(request, accessToken, intentId)).find(
				match,
			);
			return found !== undefined;
		},
		timeout,
		500,
	);
	return found as DevLatchItem;
};

/** POST /v1/latches/{id}/response(yes/defer/no・200の操作後LatchDTOを保証) */
export const respond = async (
	request: APIRequestContext,
	accessToken: string,
	latchId: string,
	response: LatchResponseValue,
): Promise<LatchDTO> => {
	const res = await request.post(`/v1/latches/${latchId}/response`, {
		data: { response },
		headers: bearer(accessToken),
	});
	expect(res.status(), `POST /v1/latches/{id}/response(${response})`).toBe(200);
	return (await res.json()) as LatchDTO;
};

/**
 * POST /v1/dev/latches/{id}/backdate(時計を操作せずに期限経過・見送り後の抑制解除・
 * 30分再評価抑制の解除を作る・F4a計画Task 17)。日時はISO 8601で渡す
 */
export const backdate = async (
	request: APIRequestContext,
	accessToken: string,
	latchId: string,
	body: {
		response_deadline?: string;
		history_updated_at?: string;
		intents_last_evaluated_at?: string;
	},
): Promise<void> => {
	const res = await request.post(`/v1/dev/latches/${latchId}/backdate`, {
		data: body,
		headers: bearer(accessToken),
	});
	expect(res.status(), "POST /v1/dev/latches/{id}/backdate").toBe(200);
};

/** チャットWebSocketの受信フレーム(F6a設計 §2のサーバー→クライアント) */
export interface ChatFrame {
	type: string;
	[key: string]: unknown;
}

/** 受信フレームを溜めて型指定で取り出せる接続(試験終了時にclose()する) */
export interface ChatSocket {
	frames: ChatFrame[];
	send: (frame: Record<string, unknown>) => void;
	close: () => void;
}

/** ws-ticketを発行してチャットWebSocketへ接続し、openを待って返す */
export const connectChat = async (
	request: APIRequestContext,
	baseURL: string,
	accessToken: string,
	latchId: string,
): Promise<ChatSocket> => {
	const ticketRes = await request.post("/v1/ws-ticket", {
		data: { scope: "chat", latch_id: latchId },
		headers: bearer(accessToken),
	});
	expect(ticketRes.status(), "POST /v1/ws-ticket").toBe(200);
	const { ticket } = (await ticketRes.json()) as { ticket: string };
	const url = `${baseURL.replace(/^http/, "ws")}/v1/latches/${latchId}/ws?ticket=${ticket}`;
	const ws = new WebSocket(url);
	const frames: ChatFrame[] = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(String(event.data)) as ChatFrame);
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("WebSocket接続失敗")), {
			once: true,
		});
	});
	return {
		frames,
		send: (frame) => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
	};
};

/** 指定typeのフレームが届くまで待って返す(届いたフレームは消費する) */
export const nextFrame = async (
	socket: ChatSocket,
	type: string,
	timeout = 10_000,
): Promise<ChatFrame> => {
	let found: ChatFrame | undefined;
	await waitFor(
		async () => {
			const index = socket.frames.findIndex((f) => f.type === type);
			if (index < 0) {
				return false;
			}
			found = socket.frames.splice(index, 1)[0];
			return true;
		},
		timeout,
		50,
	);
	return found as ChatFrame;
};
