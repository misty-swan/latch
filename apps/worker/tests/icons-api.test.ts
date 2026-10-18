/**
 * アイコンAPI(POST/DELETE /v1/users/me/icon・GET /v1/users/{user_id}/icon)の統合試験。
 * docs/05 §3.2(エンドポイント)・§2.3(R2アイコン: キー={user ULID}/{ULID}・Workerで
 * 検証して保存)・docs/08 §11(形式・サイズを検証してから保存・コンテンツ種別を固定して配信)。
 * SELF.fetchでWorker全体(index.tsのdefault export)を通して呼ぶ。
 * 登録フローはusers-api.test.tsと同じ実フロー(auth/token→POST /v1/users)を使う。
 * アップロードはContent-Typeを申告させない(生バイトのmagic bytes判定を検証する)。
 */

import { env, SELF } from "cloudflare:test";
import { LIMITS } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
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

/** 「JSTの今日からyears年前」の誕生日('YYYY-MM-DD')。統合試験はsystemClockで動くため現在日からの相対値 */
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

/** auth/tokenで登録前JWT(sub無し)を取得する実フロー(docs/05 §3.2)。subjectのusers行が未登録である前提 */
const getPreRegistrationToken = async (subject: string): Promise<string> => {
	const res = await SELF.fetch("https://localhost/v1/auth/token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "google",
			idp_token: await signIdpToken(subject),
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		access_token: string;
		registration_required: boolean;
	};
	expect(body.registration_required).toBe(true);
	return body.access_token;
};

/** 登録済みユーザー(とアクセストークン)を作る */
const registerUser = async (
	displayName: string,
): Promise<{ userId: string; accessToken: string }> => {
	const subject = `icon-${crypto.randomUUID()}`;
	const preregToken = await getPreRegistrationToken(subject);
	const res = await SELF.fetch("https://localhost/v1/users", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${preregToken}`,
		},
		body: JSON.stringify({
			display_name: displayName,
			birth_date: birthDateYearsAgo(20),
		}),
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { userId: body.user.id, accessToken: body.access_token };
};

/** 生バイト列をアイコンAPIへアップロードする(Content-Typeは申告しない=CLS・申告に依存しない) */
const postIcon = (
	accessToken: string,
	bytes: Uint8Array,
	headers: Record<string, string> = {},
): Promise<Response> =>
	SELF.fetch("https://localhost/v1/users/me/icon", {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, ...headers },
		body: bytes,
	});

/** 実在する1x1 PNG(8-bit RGBA・70バイト)。テスト内定数(base64) */
const PNG_1X1 = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	),
	(ch) => ch.charCodeAt(0),
);

/** GIFの先頭バイト(対応外形式・docs/05 §2.3: 受け付けはPNG/JPEG/WebP) */
const GIF_BYTES = Uint8Array.from("GIF89a", (ch) => ch.charCodeAt(0));

/** JPEGの先頭バイト(FF D8 FF+JFIFヘッダの先頭) */
const JPEG_BYTES = Uint8Array.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

/** docs/05 §3.1のエラー応答の形状 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

/** UserDTOの形状(docs/05 §3.3) */
interface UserDtoShape {
	id: string;
	display_name: string;
	bio: string;
	has_icon: boolean;
}

/** users行のicon_keyを取り出す(テストでR2キーを推測せずD1の正から取る) */
const getIconKey = async (userId: string): Promise<string> => {
	const [row] = await db.select().from(users).where(eq(users.id, userId));
	if (row?.iconKey === undefined || row.iconKey === null) {
		throw new Error("users.icon_keyが設定されていない");
	}
	return row.iconKey;
};

/** users行を直接status=deletedへ更新する(docs/05 §2.5相当の退会の準備) */
const markDeleted = async (userId: string): Promise<void> => {
	await db
		.update(users)
		.set({ status: "deleted", updatedAt: new Date() })
		.where(eq(users.id, userId));
};

describe("POST /v1/users/me/icon(docs/05 §3.2・08 §11: アイコン登録)", () => {
	it("1x1 PNGをアップロードすると201 UserDTO(has_icon=true)・R2に同バイトで保存・icon_key更新", async () => {
		const { userId, accessToken } = await registerUser("アイコン太郎");

		const res = await postIcon(accessToken, PNG_1X1);
		expect(res.status).toBe(201);
		const body = (await res.json()) as UserDtoShape;
		expect(body).toEqual({
			id: userId,
			display_name: "アイコン太郎",
			bio: "",
			has_icon: true,
		});

		// R2キーは{userId}/{ULID}(docs/05 §2.3)。D1の正から取る
		const key = await getIconKey(userId);
		expect(key.startsWith(`${userId}/`)).toBe(true);
		const ulidPart = key.slice(userId.length + 1);
		expect(ulidPart).toMatch(/^[0-9A-Z]{26}$/);

		// R2にアップロードしたバイト列そのもので保存され・Content-Typeは検証結果で固定される
		const object = await testEnv.ICONS.get(key);
		if (object === null) {
			throw new Error("R2オブジェクトが保存されていない");
		}
		expect(new Uint8Array(await object.arrayBuffer())).toEqual(PNG_1X1);
		expect(object.httpMetadata?.contentType).toBe("image/png");
	});

	it("GIFバイト(拡張子偽装でcontent-type: image/pngを申告)は400 VALIDATION_FAILED", async () => {
		const { accessToken } = await registerUser("GIF偽装太郎");
		const res = await postIcon(accessToken, GIF_BYTES, {
			"content-type": "image/png",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("1MB+1バイト(PNG署名付き)は400 VALIDATION_FAILED(サイズ上限・docs/08 §11)", async () => {
		const { accessToken } = await registerUser("サイズ超過太郎");
		// 先頭をPNG署名にして、sniffではなくサイズ超過の分岐で落ちることを保証する
		const oversized = new Uint8Array(LIMITS.ICON_MAX_BYTES + 1);
		oversized.set(PNG_1X1, 0);
		const res = await postIcon(accessToken, oversized);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("未認証(Authorization無し)のアップロードは401", async () => {
		const res = await SELF.fetch("https://localhost/v1/users/me/icon", {
			method: "POST",
			body: PNG_1X1,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /v1/users/{user_id}/icon(docs/05 §3.2: 未認証取得)", () => {
	it("未認証(Authorization無し)で200・同バイト・検証済みContent-Type・Cache-Control: private", async () => {
		const { userId, accessToken } = await registerUser("配信太郎");
		const upload = await postIcon(accessToken, PNG_1X1);
		expect(upload.status).toBe(201);

		const res = await SELF.fetch(`https://localhost/v1/users/${userId}/icon`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		// private(共有キャッシュに載せない・docs/05 §3.2)
		expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_1X1);
	});

	it("アイコン未設定ユーザーは404 NOT_FOUND", async () => {
		const { userId } = await registerUser("アイコン無し太郎");
		const res = await SELF.fetch(`https://localhost/v1/users/${userId}/icon`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("存在しないuser_idは404 NOT_FOUND", async () => {
		const res = await SELF.fetch(
			`https://localhost/v1/users/${"0".repeat(26)}/icon`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("削除済みユーザーは404 NOT_FOUND(Review Focus #5)", async () => {
		const { userId, accessToken } = await registerUser("退会済み太郎");
		const upload = await postIcon(accessToken, PNG_1X1);
		expect(upload.status).toBe(201);
		await markDeleted(userId);

		const res = await SELF.fetch(`https://localhost/v1/users/${userId}/icon`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorResponse;
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("DELETE /v1/users/me/icon(docs/05 §3.2: アイコン削除)", () => {
	it("削除すると204・R2オブジェクト消失・GETは404・icon_key=null・再DELETEも204(冪等)", async () => {
		const { userId, accessToken } = await registerUser("削除太郎");
		const upload = await postIcon(accessToken, PNG_1X1);
		expect(upload.status).toBe(201);
		const key = await getIconKey(userId);

		const res = await SELF.fetch("https://localhost/v1/users/me/icon", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(204);

		// R2オブジェクトが消失している
		expect(await testEnv.ICONS.head(key)).toBeNull();

		// users.icon_keyがnullに戻る
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(row?.iconKey).toBeNull();

		// GETは404になる
		const got = await SELF.fetch(`https://localhost/v1/users/${userId}/icon`);
		expect(got.status).toBe(404);

		// アイコン無し状態でもう一度DELETEしても204(冪等)
		const again = await SELF.fetch("https://localhost/v1/users/me/icon", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(again.status).toBe(204);
	});

	it("未認証(Authorization無し)の削除は401", async () => {
		const res = await SELF.fetch("https://localhost/v1/users/me/icon", {
			method: "DELETE",
		});
		expect(res.status).toBe(401);
	});
});

describe("アイコンの再アップロード(docs/05 §2.3: キーはアップロードごとに新採番)", () => {
	it("再アップロードで古いR2キーのオブジェクトが削除され・新キーに差し替わる", async () => {
		const { userId, accessToken } = await registerUser("差し替え太郎");
		const first = await postIcon(accessToken, PNG_1X1);
		expect(first.status).toBe(201);
		const oldKey = await getIconKey(userId);

		const second = await postIcon(accessToken, JPEG_BYTES);
		expect(second.status).toBe(201);
		const newKey = await getIconKey(userId);
		expect(newKey).not.toBe(oldKey);

		// 古いオブジェクトは削除・新しいオブジェクトのみ残る
		expect(await testEnv.ICONS.head(oldKey)).toBeNull();
		const object = await testEnv.ICONS.get(newKey);
		if (object === null) {
			throw new Error("R2オブジェクトが保存されていない");
		}
		expect(object.httpMetadata?.contentType).toBe("image/jpeg");
	});
});
