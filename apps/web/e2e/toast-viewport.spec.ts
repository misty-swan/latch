/**
 * 遷移の後のトースト(RouteToast)の置き場のブラウザE2E(LAT-110)。
 * iPhoneの大きさ(幅390×高さ844)で、トーストが見えている範囲に出て、下の操作
 * (フッターのボタン・タブバー)と重ならないことを、トーストを出す全画面
 * (Home・Connections・IntentDetail・Welcome・Compose)で確かめる。
 * - 意思の詳細(直しました。)とホーム(取り下げました。)は実際の操作で出し、画面が
 *   見えている範囲より長い(スクロールしていない状態で下端が外にある)ことも確かめる
 * - つながり・はじめの画面・書く画面は、遷移元が渡すstate.toastを履歴に入れて出す
 *   (遷移元の操作はpwa-flow・withdraw-flow・flowの各specで証明済み)
 * - 地域を使わない(提案を作らない)。各testの前後でE2EユーザーのactiveなIntentを倒す
 */

import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	captureAccessToken,
	composeAndRead,
	expireLeftoverE2eIntents,
	placeAndBackToHome,
	signInAndRegister,
} from "./helpers";

const IPHONE = { width: 390, height: 844 };

/** 意思の詳細が見えている範囲より長くなるよう、ひとことを長くする */
const LONG_WORDS =
	"週末の朝に、近所の公園をゆっくり歩きながら、季節の草花や鳥の名前を教え合える人と知り合いたい。" +
	"写真を撮るのも好きなので、撮ったものを見せ合ったり、おすすめの散歩道を交換したりできるとうれしい。" +
	"急がず、無理のない間隔で、長く続けられる関係になれたらと思っている。";

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

/** iPhoneの大きさのcontextで登録まで進める */
const setUpIphoneUser = async (
	browser: Browser,
	displayName: string,
): Promise<{ page: Page; token: string }> => {
	const context = await browser.newContext({ viewport: IPHONE });
	const page = await context.newPage();
	await signInAndRegister(page, displayName);
	const tokenPromise = captureAccessToken(page);
	await page.reload();
	return { page, token: await tokenPromise };
};

/**
 * 遷移元が渡すstate.toastを、いまの画面の履歴に入れて出す(react-routerは履歴のstateの
 * usrをlocation.stateとして読む。popstateで読み直させる)
 */
const showRouteToast = async (page: Page, text: string): Promise<void> => {
	await page.evaluate((toast) => {
		const idx = (window.history.state?.idx ?? 0) + 1;
		window.history.pushState(
			{ usr: { toast }, key: `e2e-${idx}`, idx },
			"",
			window.location.pathname,
		);
		window.dispatchEvent(
			new PopStateEvent("popstate", { state: window.history.state }),
		);
	}, text);
};

/**
 * 画面が見えている範囲より長いか(スクロールしないと下端が見えない)。
 * 文書全体がスクロールする作りと、.screen__body の内側でスクロールする作りのどちらでも測る
 */
const isTallerThanViewport = (page: Page): Promise<boolean> =>
	page.evaluate(
		() =>
			document.documentElement.scrollHeight > window.innerHeight ||
			[...document.querySelectorAll(".screen__body")].some(
				(b) => b.scrollHeight > b.clientHeight,
			),
	);

/**
 * トーストが見えている範囲に収まり、見えている下の操作のボタン・リンクと重ならないこと。
 * 出るときの動き(toast-in)が終わってから位置を測る
 */
const expectToastClear = async (page: Page, text: string): Promise<void> => {
	const toast = page.getByRole("status").filter({ hasText: text });
	await expect(toast).toBeVisible();
	await toast.evaluate((el) =>
		Promise.all(el.getAnimations().map((a) => a.finished)),
	);
	await expect(toast).toBeInViewport({ ratio: 1 });
	const overlapped = await toast.evaluate((el) => {
		const t = el.getBoundingClientRect();
		return [
			...document.querySelectorAll(
				".screen__foot :is(a, button), .tabbar :is(a, button)",
			),
		]
			.filter((c) => {
				const r = c.getBoundingClientRect();
				return (
					r.height > 0 &&
					r.top < t.bottom &&
					r.bottom > t.top &&
					r.left < t.right &&
					r.right > t.left
				);
			})
			.map((c) => c.textContent?.trim() ?? "");
	});
	expect(overlapped, "トーストと重なる下の操作").toEqual([]);
};

test("iPhoneの大きさで、意思の詳細とホームのトーストが見えている範囲に出て、下の操作と重ならない", async ({
	browser,
}) => {
	const { page } = await setUpIphoneUser(browser, "E2Eあかり");
	await composeAndRead(page, LONG_WORDS);
	const card = await placeAndBackToHome(page, LONG_WORDS);

	// 意思の詳細: 内容を直す→保存して詳細へ戻る(実機確認の項目5)
	await card.click();
	await expect(page).toHaveURL(/\/intents\/[^/]+$/);
	const id = new URL(page.url()).pathname.split("/").pop() as string;
	await page.getByRole("link", { name: "内容を直す" }).click();
	await page.getByRole("button", { name: "主題を直す" }).click();
	await page.locator('input[aria-label="主題"]').fill("散歩と草花の仲間");
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "直して預ける" }).click();
	await page
		.getByRole("dialog", { name: "直す前の確認" })
		.getByRole("button", { name: "直して預ける" })
		.click();
	await expect(page).toHaveURL(new RegExp(`/intents/${id}$`));
	await page.evaluate(() => {
		window.scrollTo(0, 0);
		for (const b of document.querySelectorAll(".screen__body")) b.scrollTop = 0;
	});
	expect(await isTallerThanViewport(page), "意思の詳細が長い").toBe(true);
	await expectToastClear(page, "直しました。");

	// 意思の詳細の中のトースト(一時停止しました。)も同じ置き場
	await page.getByRole("button", { name: "一時停止する" }).click();
	await expectToastClear(page, "一時停止しました。");
	await page.getByRole("button", { name: "再開する" }).click();
	await expectToastClear(page, "再開しました。");

	// ホーム: 取り下げる→ホームへ戻る(タブバーの上に出る)
	await page.getByRole("button", { name: "取り下げる" }).click();
	await page
		.getByRole("dialog", { name: "取り下げの確認" })
		.getByRole("button", { name: "取り下げる" })
		.click();
	await expect(page).toHaveURL(/\/home$/);
	await expectToastClear(page, "取り下げました。");
});

test("iPhoneの大きさで、つながり・はじめの画面・書く画面のトーストが見えている範囲に出て、下の操作と重ならない", async ({
	browser,
}) => {
	const { page } = await setUpIphoneUser(browser, "E2Eなぎさ");

	// つながり(タブバーの上に出る)
	await page.goto("/connections");
	await expect(page.locator(".tabbar")).toBeVisible();
	await showRouteToast(page, "一覧から消しました。");
	await expectToastClear(page, "一覧から消しました。");

	// 書く画面(フッターの「読み解く」の上に出る)
	await page.goto("/compose");
	await expect(page.locator("#c-text")).toBeVisible();
	await showRouteToast(page, "オフラインのため、いまは読み解けません。");
	await expectToastClear(page, "オフラインのため、いまは読み解けません。");

	// はじめの画面(退会の後・[はじめる]の上に出る。実機確認の項目14)
	const welcome = await (
		await browser.newContext({ viewport: IPHONE })
	).newPage();
	await welcome.goto("/welcome");
	await expect(welcome.getByRole("link", { name: "はじめる" })).toBeVisible();
	await showRouteToast(welcome, "退会しました。");
	await expectToastClear(welcome, "退会しました。");
});
