/**
 * dev専用サインインAPI(POST /v1/dev/idp-token)の統合試験(F2' Task 2)。
 * - テスト鍵モード(秘密鍵LATCH_TEST_IDP_PRIVATE_JWKS+公開JWKS LATCH_TEST_IDP_JWKS
 *   が設定されている場合)のみ200でRS256署名済みIdPトークンを返し、それで
 *   POST /v1/auth/tokenが通る(=通常の認証フローにそのまま乗る・docs/04 §4)
 * - 秘密鍵未設定・公開JWKS未設定・LATCH_ENV=productionは存在を隠すため
 *   一律404 NOT_FOUND(共通エラー形状・docs/05 §3.1)
 * - prod起動ガード(assertEnvSafety)の二重防御はenv.test.tsが担う
 * ハッピーパスはSELF.fetchでWorker全体を通し、env条件違いはdevRoutes.requestで
 * Envを差し替えて検証する(テスト結合のLATCH_ENV書き換えは起動ガードと干渉するため)
 */

import { env, SELF } from "cloudflare:test";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import type { Env } from "../src/env";
import { devRoutes } from "../src/routes/dev";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;

/** テスト鍵モードが有効なEnv(vitest.config.tsのbindingsと同じ値) */
const testKeyEnv = {
	LATCH_ENV: "local",
	LATCH_TEST_IDP_JWKS: testEnv.LATCH_TEST_IDP_JWKS,
	LATCH_TEST_IDP_PRIVATE_JWKS: privateJwkText,
} as unknown as Env;

/** docs/05 §3.1のエラー応答の形状 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

/** devRoutesへEnvを差し替えてPOSTするヘルパー(サブアプリ単位の単体検証) */
const postToDevRoutes = async (
	body: string | undefined,
	overrideEnv: Partial<Env> = {},
): Promise<Response> =>
	await devRoutes.request(
		"/idp-token",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
		{ ...testKeyEnv, ...overrideEnv } as unknown as Env,
	);

describe("POST /v1/dev/idp-token(F2' Task 2: dev専用サインイン)", () => {
	it("テスト鍵モードではsubjectからRS256署名済みidp_tokenを発行する(iss/aud/sub/exp/kidを検証)", async () => {
		const subject = `dev-${crypto.randomUUID()}`;
		const res = await SELF.fetch("https://localhost/v1/dev/idp-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { idp_token: string };
		expect(typeof body.idp_token).toBe("string");

		const header = decodeProtectedHeader(body.idp_token);
		expect(header.alg).toBe("RS256");
		expect(header.kid).toBe("test-idp-key-1");
		const claims = decodeJwt(body.idp_token);
		expect(claims.iss).toBe(TEST_IDP_ISSUER);
		expect(claims.aud).toBe(TEST_IDP_AUDIENCE);
		expect(claims.sub).toBe(subject);
		// exp=now+600(秒・署名時点と検証時点の誤差を見て幅を持たせる)
		expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590);
		expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 610);
	});

	it("発行したidp_tokenでPOST /v1/auth/tokenが200(registration_required=true)になる", async () => {
		const devRes = await SELF.fetch("https://localhost/v1/dev/idp-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject: `dev-${crypto.randomUUID()}` }),
		});
		expect(devRes.status).toBe(200);
		const devBody = (await devRes.json()) as { idp_token: string };
		const tokenRes = await SELF.fetch("https://localhost/v1/auth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "google",
				idp_token: devBody.idp_token,
			}),
		});
		expect(tokenRes.status).toBe(200);
		const tokenBody = (await tokenRes.json()) as {
			registration_required: boolean;
			user: unknown;
		};
		expect(tokenBody.registration_required).toBe(true);
		expect(tokenBody.user).toBeNull();
	});

	it("64字のsubjectは受理する(上限の境界)", async () => {
		const res = await postToDevRoutes(
			JSON.stringify({ subject: "a".repeat(64) }),
		);
		expect(res.status).toBe(200);
	});

	it("65字のsubjectは400 VALIDATION_FAILED(上限超過)", async () => {
		const res = await postToDevRoutes(
			JSON.stringify({ subject: "a".repeat(65) }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details).toEqual({});
	});

	it("subject欠落・空文字・非文字列は400 VALIDATION_FAILED", async () => {
		for (const body of [
			JSON.stringify({}),
			JSON.stringify({ subject: "" }),
			JSON.stringify({ subject: 123 }),
			undefined,
		]) {
			const res = await postToDevRoutes(body);
			expect(res.status).toBe(400);
			const errorBody = (await res.json()) as ErrorResponse;
			expect(errorBody.error.code).toBe("VALIDATION_FAILED");
		}
	});

	it("秘密鍵(LATCH_TEST_IDP_PRIVATE_JWKS)未設定は404 NOT_FOUND(存在を隠す)", async () => {
		const res = await postToDevRoutes(JSON.stringify({ subject: "dev" }), {
			LATCH_TEST_IDP_PRIVATE_JWKS: undefined,
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		expect(body.error.details).toEqual({});
	});

	it("公開JWKS(LATCH_TEST_IDP_JWKS)未設定も404 NOT_FOUND(テスト鍵モードが無効な構成)", async () => {
		const res = await postToDevRoutes(JSON.stringify({ subject: "dev" }), {
			LATCH_TEST_IDP_JWKS: undefined,
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("LATCH_ENV=production相当では404 NOT_FOUND(ボディが正しくても存在を隠す)", async () => {
		const res = await postToDevRoutes(JSON.stringify({ subject: "dev" }), {
			LATCH_ENV: "production",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
		// 秘密鍵未設定の404と同じ応答にする(理由を区別できない)
		expect(body.error.message.length).toBeGreaterThan(0);
	});
});
