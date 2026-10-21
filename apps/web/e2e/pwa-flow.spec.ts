/**
 * PWAと仕上げのブラウザE2E(F8a計画Task 9・F8a設計 §4.1・§5.2)。
 * docs/02 §4の#32のうち自動で確かめられる部分(意思の詳細の操作・Service Worker制御下の
 * オフライン表示・ホーム画面追加の要件)を証明する。実機ブラウザでの確認は手順書で行う。
 * - 地域を使わない(提案を作らない)。各testの前後でE2EユーザーのactiveなIntentを倒す
 * - 待ち合わせは画面上の明示セレクタで行う(スリープを置かない)
 */

import { expect, type Page, test } from "@playwright/test";
import {
	composeAndRead,
	expireLeftoverE2eIntents,
	placeAndBackToHome,
	setUpUser,
	signInAndRegister,
} from "./helpers";

const OFFLINE_BANNER = "オフラインです。最後に確かめた内容を表示しています。";

/** GET /v1/intents/{id}の結果のうち、この試験が見る欄 */
interface IntentDetailForCheck {
	status: string;
	topic: string | null;
	notification_level: string;
}

/**
 * ページが持つアクセストークンで意思を1件取る。
 * fetchIntentsViaApiはリフレッシュトークンを回すため、試験の途中で使うとページ側の
 * セッションが切れる。ここではsetUpUserで得たアクセストークンをそのまま使う
 */
const fetchIntentViaApi = async (
	page: Page,
	token: string,
	id: string,
): Promise<IntentDetailForCheck> => {
	const res = await page.request.get(`/v1/intents/${id}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(res.status(), "GET /v1/intents/{id}").toBe(200);
	return (await res.json()) as IntentDetailForCheck;
};

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("意思の詳細で一時停止・再開・通知の切り替え・直す・取り下げができる", async ({
	browser,
}) => {
	const { page, token } = await setUpUser(browser, "E2Eしおり");
	await page.goto("/home");
	const words = "料理が好きな人と、ときどきレシピを教え合える関係になりたい。";
	await composeAndRead(page, words);
	await expect(
		page.locator('input[name="form"][value="connection"]'),
	).toBeChecked();
	const card = await placeAndBackToHome(page, words);

	// ホームの行を押すと意思の詳細へ
	await card.click();
	await expect(page).toHaveURL(/\/intents\/[^/]+$/);
	const id = new URL(page.url()).pathname.split("/").pop() as string;
	await expect(page.getByText(words)).toBeVisible();

	// 一時停止→再開
	await page.getByRole("button", { name: "一時停止する" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "一時停止しました。" }),
	).toBeVisible();
	await expect(
		page.locator(".status", { hasText: "一時停止中" }),
	).toBeVisible();
	const switchInput = page.getByRole("checkbox", {
		name: "この意思の提案をお知らせする",
	});
	// pausedはPATCHできないためスイッチは押せない
	await expect(switchInput).toBeDisabled();
	await page.getByRole("button", { name: "再開する" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "再開しました。" }),
	).toBeVisible();
	await expect(
		page.locator(".status", { hasText: "預けている" }),
	).toBeVisible();
	expect((await fetchIntentViaApi(page, token, id)).status).toBe("active");

	// 通知のスイッチを切る→notification_levelがmuted
	await expect(switchInput).toBeChecked();
	await expect(switchInput).toBeEnabled();
	const patched = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === `/v1/intents/${id}` &&
			r.request().method() === "PATCH" &&
			r.ok(),
	);
	// 入力は見た目のスライダーの下に隠れているため、checkboxを直接切り替える
	await switchInput.setChecked(false, { force: true });
	await patched;
	await expect(switchInput).not.toBeChecked();
	expect((await fetchIntentViaApi(page, token, id)).notification_level).toBe(
		"muted",
	);

	// 内容を直す→主題を直す→確認→詳細へ戻って「直しました。」と新しい主題
	await page.getByRole("link", { name: "内容を直す" }).click();
	await expect(page).toHaveURL(new RegExp(`/intents/${id}/edit$`));
	const newTopic = "レシピを教え合う仲間";
	await page.getByRole("button", { name: "主題を直す" }).click();
	await page.locator('input[aria-label="主題"]').fill(newTopic);
	await page.keyboard.press("Enter");
	await expect(page.locator(".fact__val", { hasText: newTopic })).toBeVisible();
	await page.getByRole("button", { name: "直して預ける" }).click();
	const confirmSheet = page.getByRole("dialog", { name: "直す前の確認" });
	await expect(
		confirmSheet.getByText("直すと、届いている提案は取り消されます。"),
	).toBeVisible();
	await confirmSheet.getByRole("button", { name: "直して預ける" }).click();
	await expect(page).toHaveURL(new RegExp(`/intents/${id}$`));
	await expect(
		page.getByRole("status").filter({ hasText: "直しました。" }),
	).toBeVisible();
	await expect(page.locator(".fact__val", { hasText: newTopic })).toBeVisible();
	expect((await fetchIntentViaApi(page, token, id)).topic).toBe(newTopic);

	// 取り下げる→確認→ホームで「取り下げました。」と行が消える
	await page.getByRole("button", { name: "取り下げる" }).click();
	const cancelSheet = page.getByRole("dialog", { name: "取り下げの確認" });
	await expect(
		cancelSheet.getByText(
			"この意思を取り下げます。届いている提案も取り消されます。",
		),
	).toBeVisible();
	await cancelSheet.getByRole("button", { name: "取り下げる" }).click();
	await expect(page).toHaveURL(/\/home$/);
	await expect(
		page.getByRole("status").filter({ hasText: "取り下げました。" }),
	).toBeVisible();
	await expect(page.locator(".intent", { hasText: words })).toHaveCount(0);
});

test("Service Workerの制御下では、オフラインでも保存済みの一覧と帯を出し、読み解きは案内する", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await signInAndRegister(page, "E2Eかなた");
	const words =
		"古い映画が好きな人と、観た感想をのんびり話せる関係になりたい。";
	await composeAndRead(page, words);
	await placeAndBackToHome(page, words);

	// Service Workerが有効になるのを待ち、再読み込みしてページを制御下に置く
	// (初回の読み込みは制御下にないため、そのままではオフラインの読み込みを答えられない)
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	await page.reload();
	await expect(page.locator(".intent", { hasText: words })).toBeVisible();
	expect(
		await page.evaluate(() => navigator.serviceWorker.controller !== null),
	).toBe(true);

	// オフラインにして読み込み直す。画面はService Workerの保存から、一覧は端末の保存から出る
	// (chromiumのsetOfflineはService Workerを通る取得にも効くことを確かめたため、
	// context.routeでの/v1/の遮断は併用しない。効いていなければ下の読み解きが成功して失敗する)
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText(OFFLINE_BANNER)).toBeVisible();
	await expect(page.locator(".intent", { hasText: words })).toBeVisible();

	// 置く→読み解くと、通信できないので入力欄へ戻って案内が出る
	await page.getByRole("link", { name: "置く" }).click();
	await page
		.locator("#c-text")
		.fill("週末に、近くで一緒に散歩できる人がいたら嬉しい。");
	await page.getByRole("button", { name: "読み解く" }).click();
	await expect(page).toHaveURL(/\/compose$/);
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "オフラインのため、いまは読み解けません。" }),
	).toBeVisible();

	// ホームへ戻ってオンラインに戻すと帯が消える
	// (オフラインの画面遷移もService Workerが答える)
	await page.goto("/home");
	await expect(page.getByText(OFFLINE_BANNER)).toBeVisible();
	await context.setOffline(false);
	await expect(page.getByText(OFFLINE_BANNER)).toHaveCount(0);
	const card = page.locator(".intent", { hasText: words });
	await expect(card).toBeVisible();

	// 意思の詳細を開いたままオフラインになり、一時停止を押すと案内が出る。
	// オンラインに戻っても、押した操作が後から送られることはない(activeのまま)
	await card.click();
	await expect(page).toHaveURL(/\/intents\/[^/]+$/);
	const pauseButton = page.getByRole("button", { name: "一時停止する" });
	await expect(pauseButton).toBeEnabled();
	let pauseResponses = 0;
	page.on("response", (res) => {
		if (new URL(res.url()).pathname.endsWith("/pause")) pauseResponses += 1;
	});
	await context.setOffline(true);
	await pauseButton.click();
	await expect(
		page.getByText("オフラインのため、いまは操作できません。"),
	).toBeVisible();
	await expect(pauseButton).toBeEnabled();
	await context.setOffline(false);
	await page.reload();
	await expect(
		page.locator(".status", { hasText: "預けている" }),
	).toBeVisible();
	await expect(page.locator(".status", { hasText: "一時停止中" })).toHaveCount(
		0,
	);
	expect(pauseResponses).toBe(0);
	await context.close();
});

test("ホーム画面追加の要件(manifestとアイコン)を満たす", async ({
	page,
	request,
}) => {
	const manifestRes = await request.get("/manifest.webmanifest");
	expect(manifestRes.status(), "GET /manifest.webmanifest").toBe(200);
	const manifest = (await manifestRes.json()) as {
		name?: string;
		display?: string;
		start_url?: string;
		icons?: { src: string; type: string }[];
	};
	expect(manifest.name).toBe("LATCH");
	expect(manifest.display).toBe("standalone");
	expect(manifest.start_url).toBeTruthy();
	const icons = manifest.icons ?? [];
	expect(icons.map((icon) => icon.src).sort()).toEqual([
		"icon-192.png",
		"icon-512.png",
		"icon-maskable-512.png",
		"icon.svg",
	]);
	for (const icon of icons) {
		const res = await request.get(`/${icon.src}`);
		expect(res.status(), `GET /${icon.src}`).toBe(200);
		const expectedType = icon.src.endsWith(".svg")
			? "image/svg+xml"
			: "image/png";
		expect(res.headers()["content-type"]).toContain(expectedType);
	}

	await page.goto("/welcome");
	await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
		"href",
		"/apple-touch-icon.png",
	);
	const touchIcon = await request.get("/apple-touch-icon.png");
	expect(touchIcon.status(), "GET /apple-touch-icon.png").toBe(200);
	expect(touchIcon.headers()["content-type"]).toContain("image/png");
});
