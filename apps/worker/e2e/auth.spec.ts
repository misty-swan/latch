/**
 * 認証フローのE2E(APIレベル・docs/05 §3.2・docs/04 §4)。
 * Playwrightのrequest fixture(APIRequestContext)のみを使用しブラウザは不要。
 * wrangler dev(8787・prepare-dev-vars.mjsが生成した.dev.varsでテスト鍵モード)へ
 * 実HTTPで各APIを呼び出し、docs/05 §3.1の共通エラー形状まで含めて確認する。
 * ローカルD1は実行間で永続するため、subはテストごとにランダム生成して汚染を避ける
 */

import { type APIRequestContext, expect, test } from "@playwright/test";
import { signForeignIdpToken, signIdpToken } from "./helpers";

/** docs/05 §3.2のPOST /v1/auth/token成功応答 */
interface TokenResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
	user: UserDTO | null;
	registration_required: boolean;
}

/** docs/05 §3.2のPOST /v1/users成功応答(201) */
interface RegisterResponse {
	user: UserDTO;
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/** docs/05 §3.2のPOST /v1/auth/refresh成功応答 */
interface RefreshResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/** docs/05 §3.3のUserDTO */
interface UserDTO {
	id: string;
	display_name: string;
	bio: string;
	has_icon: boolean;
}

/** docs/05 §3.1の共通エラー応答 */
interface ErrorResponse {
	error: { code: string; message: string; details: unknown };
}

/** 1x1 PNG(透明)。1バイトも違わず返却されることまで確認する(docs/08 §11) */
const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * 満17歳になる生年月日を現在日(JST)から作る(docs/05 §3.2の18歳検証に落ちる側)。
 * 18歳の誕生日が2日以上先=実行日の1日程度のずれでも17歳のままである余裕を持たせる
 */
const underAgeBirthDate = (): string => {
	const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000);
	const birth = new Date(
		Date.UTC(
			shifted.getUTCFullYear() - 18,
			shifted.getUTCMonth(),
			shifted.getUTCDate() + 2,
		),
	);
	return birth.toISOString().slice(0, 10);
};

/** テスト鍵で署名したIdPトークンでPOST /v1/auth/tokenを呼ぶ(200を保証) */
const postToken = async (
	request: APIRequestContext,
	sub: string,
): Promise<TokenResponse> => {
	const res = await request.post("/v1/auth/token", {
		data: { provider: "google", idp_token: await signIdpToken(sub) },
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as TokenResponse;
};

/** 登録まで一気に進める(POST /v1/usersの201を保証・birth_dateは既定で成人) */
const register = async (
	request: APIRequestContext,
	sub: string,
	birthDate = "2000-01-01",
): Promise<RegisterResponse> => {
	const pre = await postToken(request, sub);
	const res = await request.post("/v1/users", {
		data: { display_name: "E2Eテストユーザー", birth_date: birthDate, bio: "" },
		headers: { authorization: `Bearer ${pre.access_token}` },
	});
	expect(res.status()).toBe(201);
	return (await res.json()) as RegisterResponse;
};

test("1. 新規subでPOST /v1/auth/token → registration_required=true", async ({
	request,
}) => {
	const body = await postToken(request, `e2e-new-${crypto.randomUUID()}`);
	expect(body.registration_required).toBe(true);
	expect(body.user).toBeNull();
	expect(body.refresh_token).toBeNull();
	expect(body.access_token.length).toBeGreaterThan(0);
	expect(body.expires_in).toBeGreaterThan(0);
});

test("2. 登録前のaccess_tokenでGET /v1/users/me → 401", async ({ request }) => {
	const pre = await postToken(request, `e2e-prereg-${crypto.randomUUID()}`);
	const me = await request.get("/v1/users/me", {
		headers: { authorization: `Bearer ${pre.access_token}` },
	});
	expect(me.status()).toBe(401);
	const body = (await me.json()) as ErrorResponse;
	expect(body.error.code).toBe("UNAUTHORIZED");
});

test("3. POST /v1/users(18歳のbirth_date) → 201 user", async ({ request }) => {
	const pre = await postToken(request, `e2e-register-${crypto.randomUUID()}`);
	const registered = await request.post("/v1/users", {
		data: {
			display_name: "E2Eテストユーザー",
			birth_date: "2000-01-01",
			bio: "",
		},
		headers: { authorization: `Bearer ${pre.access_token}` },
	});
	expect(registered.status()).toBe(201);
	const body = (await registered.json()) as RegisterResponse;
	expect(body.user.id).toHaveLength(26);
	expect(body.user.display_name).toBe("E2Eテストユーザー");
	expect(body.user.bio).toBe("");
	expect(body.user.has_icon).toBe(false);
	expect(body.access_token.length).toBeGreaterThan(0);
	expect(body.refresh_token.length).toBeGreaterThan(0);
});

test("4. 登録後の新access_tokenでGET /v1/users/me → 200・PATCH → 200", async ({
	request,
}) => {
	const reg = await register(request, `e2e-me-${crypto.randomUUID()}`);
	const get = await request.get("/v1/users/me", {
		headers: { authorization: `Bearer ${reg.access_token}` },
	});
	expect(get.status()).toBe(200);
	expect((await get.json()) as UserDTO).toEqual(reg.user);
	const patch = await request.patch("/v1/users/me", {
		data: { display_name: "更新後E2Eユーザー", bio: "自己紹介" },
		headers: { authorization: `Bearer ${reg.access_token}` },
	});
	expect(patch.status()).toBe(200);
	const patched = (await patch.json()) as UserDTO;
	expect(patched.display_name).toBe("更新後E2Eユーザー");
	expect(patched.bio).toBe("自己紹介");
});

test("5. POST /v1/auth/refresh → 200・旧refresh_tokenの再提示 → 200(猶予)・3回目 → 401", async ({
	request,
}) => {
	const { refresh_token } = await register(
		request,
		`e2e-refresh-${crypto.randomUUID()}`,
	);
	// 1回目の回転: トークンが更新される
	const first = await request.post("/v1/auth/refresh", {
		data: { refresh_token },
	});
	expect(first.status()).toBe(200);
	const firstBody = (await first.json()) as RefreshResponse;
	expect(firstBody.refresh_token).not.toBe(refresh_token);
	expect(firstBody.access_token.length).toBeGreaterThan(0);
	// 直後の旧トークン再提示: 猶予で現行トークンが1回だけ返る(docs/04 §4)
	const second = await request.post("/v1/auth/refresh", {
		data: { refresh_token },
	});
	expect(second.status()).toBe(200);
	const secondBody = (await second.json()) as RefreshResponse;
	expect(secondBody.refresh_token).toBe(firstBody.refresh_token);
	// 3回目: 猶予を使い切った再提示は401(猶予窓内のため族は失効せず・docs/04 §4・05 §2.3)
	const third = await request.post("/v1/auth/refresh", {
		data: { refresh_token },
	});
	expect(third.status()).toBe(401);
	const error = (await third.json()) as ErrorResponse;
	expect(error.error.code).toBe("UNAUTHORIZED");
});

test("6. POST /v1/auth/logout → 204・logout後のaccess_tokenでGET /v1/users/me → 401", async ({
	request,
}) => {
	const { refresh_token, access_token } = await register(
		request,
		`e2e-logout-${crypto.randomUUID()}`,
	);
	const logout = await request.post("/v1/auth/logout", {
		data: { refresh_token },
		headers: { authorization: `Bearer ${access_token}` },
	});
	expect(logout.status()).toBe(204);
	expect(await logout.text()).toBe("");
	const me = await request.get("/v1/users/me", {
		headers: { authorization: `Bearer ${access_token}` },
	});
	expect(me.status()).toBe(401);
});

test("7. 1x1 PNGアップロード → 201・Authorization無しGET → 200(同bytes)・DELETE → 204・GET → 404", async ({
	request,
}) => {
	const { user, access_token } = await register(
		request,
		`e2e-icon-${crypto.randomUUID()}`,
	);
	const png = Buffer.from(PNG_1X1_BASE64, "base64");
	// 生ボディで送る(Content-Type申告は使われずmagic bytesで検証される・docs/08 §11)
	const upload = await request.post("/v1/users/me/icon", {
		data: png,
		headers: { authorization: `Bearer ${access_token}` },
	});
	expect(upload.status()).toBe(201);
	const uploaded = (await upload.json()) as UserDTO;
	expect(uploaded.id).toBe(user.id);
	expect(uploaded.has_icon).toBe(true);
	// 未認証での取得(docs/05 §3.2: GET /v1/users/{user_id}/iconはAuthorization不要)
	const gotten = await request.get(`/v1/users/${user.id}/icon`);
	expect(gotten.status()).toBe(200);
	expect(await gotten.body()).toEqual(png);
	// 削除は冪等・204(空ボディ・docs/05 §3.2)
	const deleted = await request.delete("/v1/users/me/icon", {
		headers: { authorization: `Bearer ${access_token}` },
	});
	expect(deleted.status()).toBe(204);
	// 削除後の取得は404(存在を露見させない・docs/05 §3.2)
	const afterDelete = await request.get(`/v1/users/${user.id}/icon`);
	expect(afterDelete.status()).toBe(404);
});

test("8. 17歳のbirth_date → 422 UNDER_AGE", async ({ request }) => {
	const pre = await postToken(request, `e2e-underage-${crypto.randomUUID()}`);
	const res = await request.post("/v1/users", {
		data: {
			display_name: "E2E未成年ユーザー",
			birth_date: underAgeBirthDate(),
			bio: "",
		},
		headers: { authorization: `Bearer ${pre.access_token}` },
	});
	expect(res.status()).toBe(422);
	const body = (await res.json()) as ErrorResponse;
	expect(body.error.code).toBe("UNDER_AGE");
});

test("9. でっち上げIdPトークン(鍵不一致)→ 401", async ({ request }) => {
	const res = await request.post("/v1/auth/token", {
		data: {
			provider: "google",
			idp_token: await signForeignIdpToken(`e2e-forged-${crypto.randomUUID()}`),
		},
	});
	expect(res.status()).toBe(401);
	const body = (await res.json()) as ErrorResponse;
	expect(body.error.code).toBe("UNAUTHORIZED");
});
