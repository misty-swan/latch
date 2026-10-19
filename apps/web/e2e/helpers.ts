/**
 * ブラウザE2Eの共通ヘルパー(F2'計画Task 8)。
 * - サインイン〜登録〜同意はUIの実フローで通す(devサインインはdocs/04 §4のテスト鍵。
 *   localStorageへのトークン注入は行わない・登録済みユーザーはテストごとに新規で作る。
 *   ローカルD1は実行間で永続するための汚染回避はapps/worker/e2e/helpers.tsと同じ方針)
 * - 日時は実行時のnow+2時間等をJSTの壁時計として動生成する(E2Eは実時間・docs/10 §3)
 * - 待ち合わせは画面上の明示セレクタで行う(スリープを置かない)
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** JST(+9)の壁時計でnow+hours時間のdatetime-local値を作る(starts_atの動生成) */
export const jstLocalInputPlusHours = (hours: number): string => {
	const shifted = new Date(Date.now() + hours * 3_600_000 + 9 * 3_600_000);
	const pad2 = (value: number): string => String(value).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
};

/** 満17歳になる生年月日(18歳の誕生日が2日以上先=実行日のずれでも17歳のまま) */
export const underAgeBirthDate = (): string => {
	const shifted = new Date(Date.now() + 9 * 3_600_000);
	const birth = new Date(
		Date.UTC(
			shifted.getUTCFullYear() - 18,
			shifted.getUTCMonth(),
			shifted.getUTCDate() + 2,
		),
	);
	return birth.toISOString().slice(0, 10);
};

/**
 * welcome→テストサインインをUIで通し・登録画面(/register)まで進む。
 * 生年月日は呼び出し側で埋める(18歳以上の通常登録と17歳の422確認で値が替わるため)
 */
export const signIn = async (page: Page): Promise<void> => {
	await page.goto("/welcome");
	await page.getByRole("link", { name: "アカウントをお持ちの方" }).click();
	await page.getByRole("button", { name: "Googleで続ける" }).click();
	await page.locator("#dev-name").fill(`e2e-web-${crypto.randomUUID()}`);
	await page.getByRole("button", { name: "テストではじめる" }).click();
	await expect(page.locator("#r-name")).toBeVisible();
};

/** サインイン→登録(18歳以上)→同意をUIで通し・home(空状態)まで進む */
export const signInAndRegister = async (page: Page): Promise<void> => {
	await signIn(page);
	await page.locator("#r-name").fill("E2Eユーザー");
	await page.locator("#r-birth").fill("2000-01-01");
	await page.getByRole("button", { name: "次へ" }).click();
	await page.getByRole("button", { name: "同意して進む" }).click();
};

/** homeの「ひとこと置く」からcomposeへ入り・文章を書いて「読み解く」でconfirmまで進む */
export const composeAndRead = async (
	page: Page,
	text: string,
): Promise<void> => {
	await page.getByRole("link", { name: "ひとこと置く" }).click();
	await page.locator("#c-text").fill(text);
	await page.getByRole("button", { name: "読み解く" }).click();
	await expect(
		page.getByRole("heading", { name: "こう読み解きました。" }),
	).toBeVisible();
};

/**
 * confirmの「預ける」からplaced→「預けている一覧へ」でhomeへ戻り・
 * 預けた文章のカードを返す(カードの内容の検証は呼び出し側で行う)
 */
export const placeAndBackToHome = async (
	page: Page,
	words: string,
): Promise<Locator> => {
	await page.getByRole("button", { name: "預ける" }).click();
	await expect(page.locator('p[aria-label="預けました。"]')).toBeVisible();
	await page.getByRole("link", { name: "預けている一覧へ" }).click();
	const card = page.locator(".intent", { hasText: words });
	await expect(card).toBeVisible();
	return card;
};

/**
 * UIで確立したセッション(latch.refresh)からGET /v1/intentsの結果を得る。
 * 保存されたtopic・人数などhomeのカードに現れない項目の検証に使う
 * (サインイン自体はUIの実フロー・ここではアプリが保存したトークンを読むだけ)
 */
export interface IntentForCheck {
	id: string;
	status: string;
	form: string | null;
	topic: string | null;
	raw_text: string;
	participants: { min: number; max: number };
}

export const fetchIntentsViaApi = async (
	page: Page,
): Promise<IntentForCheck[]> => {
	const refreshToken = await page.evaluate(() =>
		localStorage.getItem("latch.refresh"),
	);
	const refreshRes = await page.request.post("/v1/auth/refresh", {
		data: { refresh_token: refreshToken },
	});
	expect(refreshRes.status()).toBe(200);
	const { access_token } = (await refreshRes.json()) as {
		access_token: string;
	};
	const listRes = await page.request.get("/v1/intents?limit=50", {
		headers: { authorization: `Bearer ${access_token}` },
	});
	expect(listRes.status()).toBe(200);
	const body = (await listRes.json()) as { items: IntentForCheck[] };
	return body.items;
};
