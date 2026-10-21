/**
 * ブラウザE2Eの共通ヘルパー(F2'計画Task 8)。
 * - サインイン〜登録〜同意はUIの実フローで通す(devサインインはdocs/04 §4のテスト鍵。
 *   localStorageへのトークン注入は行わない・登録済みユーザーはテストごとに新規で作る。
 *   ローカルD1は実行間で永続するための汚染回避はapps/worker/e2e/helpers.tsと同じ方針)
 * - 日時は実行時のnow+2時間等をJSTの壁時計として動生成する(E2Eは実時間・docs/10 §3)
 * - 待ち合わせは画面上の明示セレクタで行う(スリープを置かない)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import {
	type Browser,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";

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

/**
 * サインイン→登録(18歳以上)→同意をUIで通し・home(空状態)まで進む。
 * 同意後の着地はcompose(最初の1件を預ける導線・ボードConsent.dc.htmlどおり)のため・
 * #c-textが出ることを確認してから閉じるでhomeへ戻る
 */
export const signInAndRegister = async (
	page: Page,
	displayName = "E2Eユーザー",
): Promise<void> => {
	await signIn(page);
	await page.locator("#r-name").fill(displayName);
	await page.locator("#r-birth").fill("2000-01-01");
	await page.getByRole("button", { name: "次へ" }).click();
	await page.getByRole("button", { name: "同意して進む" }).click();
	await expect(page.locator("#c-text")).toBeVisible();
	await page.getByRole("link", { name: "閉じる" }).click();
	await expect(page.getByText("まだ、何も置いていません。")).toBeVisible();
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

/**
 * ページが送る/v1/要求のauthorizationヘッダーからアクセストークンを取る(F4c計画Task 8)。
 * アクセストークンはメモリだけに持つため、ここではPOST /v1/auth/refreshを呼ばない
 * (リフレッシュトークンが回転してページ側のセッションが切れるため)。呼び出し側は
 * 待ち始めた後にpage.reload()等で/v1/要求を発生させる(返り値のPromiseを先に作る)
 */
export const captureAccessToken = async (page: Page): Promise<string> => {
	const request = await page.waitForRequest(
		(req) =>
			new URL(req.url()).pathname.startsWith("/v1/") &&
			(req.headers().authorization ?? "").startsWith("Bearer "),
	);
	return (request.headers().authorization as string).slice("Bearer ".length);
};

/**
 * つながりIntentをAPIで投入する(ゲートの対象は回答の画面のため・意思の投入画面は
 * flow.spec.tsで証明済み)。地域はapps/worker/e2e/latches.spec.tsのsiteと同じ分け方
 * (番号ごとに緯度0.1度≒11kmずらす・半径1km)。worker側と衝突しないようweb側は40以上を使う
 */
export const createConnectionIntent = async (
	page: Page,
	token: string,
	topic: string,
	site: number,
): Promise<{ id: string }> => {
	const res = await page.request.post("/v1/intents", {
		data: {
			raw_text: topic,
			form: "connection",
			topic,
			geo: { center: { lat: 33 + site * 0.1, lng: 131.5 }, radius_m: 1_000 },
		},
		headers: { authorization: `Bearer ${token}` },
	});
	expect(res.status(), "POST /v1/intents").toBe(201);
	return (await res.json()) as { id: string };
};

/** GET /v1/dev/latchesの1項目のうちE2Eが使う欄 */
export interface DevLatchForCheck {
	id: string;
	status: string;
}

/**
 * 指定Intentを含み、matchを満たすLATCHがdev観測API(GET /v1/dev/latches)に現れるまで
 * 500ms間隔・60秒上限で待って返す(パイプラインのキュー消費・回答の反映待ち)
 */
export const waitForDevLatch = async (
	page: Page,
	token: string,
	intentId: string,
	match: (item: DevLatchForCheck) => boolean,
): Promise<DevLatchForCheck> => {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const res = await page.request.get(
			`/v1/dev/latches?intent_id=${intentId}&limit=50`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status(), "GET /v1/dev/latches").toBe(200);
		const { items } = (await res.json()) as { items: DevLatchForCheck[] };
		const found = items.find(match);
		if (found !== undefined) {
			return found;
		}
		if (Date.now() >= deadline) {
			throw new Error("waitForDevLatchが60秒の上限に達しました");
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
};

/**
 * 他specが残したE2EユーザーのactiveなIntentをexpiredへ倒す
 * (apps/worker/e2e/latches.spec.tsと同じscripts/clean-e2e-data.mjs。残置Intentが
 * 提案の枠を埋めて対象ペアの提案が保留へ回るのを防ぐ)。スクリプトはwranglerを
 * PATHから呼ぶため、apps/workerのpnpm exec経由で実行する(web側にはwranglerが無い)
 */
export const expireLeftoverE2eIntents = (): void => {
	execSync("pnpm exec node scripts/clean-e2e-data.mjs", {
		cwd: path.join(import.meta.dirname, "../../worker"),
		stdio: "ignore",
	});
};

/** 1人分のcontextを作り・UIで登録し・アクセストークンを取る(両specで共有) */
export const setUpUser = async (
	browser: Browser,
	displayName: string,
): Promise<{ page: Page; token: string }> => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await signInAndRegister(page, displayName);
	const tokenPromise = captureAccessToken(page);
	await page.reload();
	return { page, token: await tokenPromise };
};

/**
 * 2人を登録し・同じtopic・同じ地域のつながりIntentを投入して提案を待ち・
 * 回答の画面はlatch-flow.spec.tsで証明済みのためAPIで2人ともyesにして成立(matched)まで進める
 */
export const establishLatch = async (
	browser: Browser,
	site: number,
	names: [string, string],
): Promise<{
	a: { page: Page; token: string };
	b: { page: Page; token: string };
	latchId: string;
}> => {
	const a = await setUpUser(browser, names[0]);
	const b = await setUpUser(browser, names[1]);
	// topicは40文字上限のため、UUIDの先頭8桁で一意にする
	const topic = `e2e-web-chat-${crypto.randomUUID().slice(0, 8)}`;
	const intentA = await createConnectionIntent(a.page, a.token, topic, site);
	await createConnectionIntent(b.page, b.token, topic, site);
	const proposed = await waitForDevLatch(
		a.page,
		a.token,
		intentA.id,
		(item) => item.status === "proposed",
	);
	for (const user of [a, b]) {
		const res = await user.page.request.post(
			`/v1/latches/${proposed.id}/response`,
			{
				data: { response: "yes" },
				headers: { authorization: `Bearer ${user.token}` },
			},
		);
		expect(res.status(), "POST /v1/latches/{id}/response").toBe(200);
	}
	await waitForDevLatch(
		a.page,
		a.token,
		intentA.id,
		(item) => item.status === "matched",
	);
	return { a, b, latchId: proposed.id };
};
