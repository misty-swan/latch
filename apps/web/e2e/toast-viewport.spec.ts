/**
 * トースト(RouteToast)の置き場のブラウザE2E(LAT-110・LAT-112)。
 * iPhoneの大きさ(幅390×高さ844)で、トーストが見えている範囲に出て、下の操作
 * (フッターのボタン・タブバー・チャットの入力欄)と重ならないことを、トーストを出す全画面
 * (Home・Connections・IntentDetail・Welcome・Compose・Shelved・Chat)で確かめる。
 * - 意思の詳細(直しました。)とホーム(取り下げました。)は実際の操作で出し、画面が
 *   見えている範囲より長い(スクロールしていない状態で下端が外にある)ことも確かめる
 * - つながり・はじめの画面・書く画面は、遷移元が渡すstate.toastを履歴に入れて出す
 *   (遷移元の操作はpwa-flow・withdraw-flow・flowの各specで証明済み)
 * - 見送った画面(Shelved)とチャットは、画面の中で出すトーストを実際の操作で出す(LAT-112)。
 *   チャットは1対1のブロックの直後(LATCHの取り直しが済むまで入力欄が残る)に、書きかけの
 *   長い文で伸びた入力欄の上に出ることを確かめる。提案はweb専用のsite 50・51
 *   (他のspecの40〜49と分ける)で作る
 * - 各testの前後でE2EユーザーのactiveなIntentを倒す
 */

import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	captureAccessToken,
	composeAndRead,
	establishLatch,
	expireLeftoverE2eIntents,
	placeAndBackToHome,
	proposeLatch,
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
 * トーストが見えている範囲に収まり、見えている下の操作(ボタン・リンク・チャットの入力欄と
 * 終了の帯)と重ならないこと。
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
				".screen__foot :is(a, button), .tabbar :is(a, button), .composer :is(textarea, button), .ended-bar",
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

test("iPhoneの大きさで、見送った画面のトーストが見えている範囲に出て、下のボタンと重ならない(LAT-112)", async ({
	browser,
}) => {
	const { a, b } = await proposeLatch(browser, 50, ["E2Eあさひ", "E2Eゆうひ"]);
	await a.page.close();
	await b.page.setViewportSize(IPHONE);

	// [今回は見送る]→見送った画面→理由を残す→トースト(「閉じる」の上に出る)
	await b.page.goto("/home");
	await b.page.getByRole("link", { name: /提案が届いています/ }).click();
	await b.page.getByRole("button", { name: "今回は見送る" }).click();
	await expect(b.page).toHaveURL(/\/latches\/[^/]+\/shelved$/);
	await b.page
		.getByRole("button", { name: "見送った理由を残す(任意)" })
		.click();
	const sheet = b.page.getByRole("dialog", { name: "見送った理由" });
	await sheet.getByRole("radio", { name: "日時や場所が合わない" }).check();
	await sheet.getByRole("button", { name: "残す" }).click();
	await expectToastClear(
		b.page,
		"ありがとうございます。相手には伝わりません。",
	);
});

test("iPhoneの大きさで、チャットのトーストが見えている範囲に出て、下の入力欄と重ならない(LAT-112)", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 51, [
		"E2Eあさひ",
		"E2Eゆうひ",
	]);
	await b.page.close();
	await a.page.setViewportSize(IPHONE);
	await a.page.goto(`/latches/${latchId}/chat`);
	const field = a.page.getByRole("textbox", { name: "メッセージ" });
	await expect(field).toBeVisible();
	// 書きかけの長い文で入力欄を伸ばす(上限の高さまで)
	await field.fill(
		Array.from({ length: 8 }, (_, i) => `${i + 1}行目`).join("\n"),
	);

	// 1対1のブロックはLATCHを取り直してから終了の帯へ切り替わる。取り直しの応答を止め、
	// 入力欄が残っているあいだに出るトーストを測る
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await a.page.route(
		(url) => url.pathname === `/v1/latches/${latchId}`,
		async (route) => {
			if (route.request().method() === "GET") await held;
			await route.continue();
		},
	);
	await a.page.getByRole("button", { name: "このつながりについて" }).click();
	await a.page
		.getByRole("dialog", { name: "このつながりについて" })
		.getByRole("button", { name: "ブロックする" })
		.click();
	await a.page
		.getByRole("dialog", { name: "ブロックの確認" })
		.getByRole("button", { name: "ブロックする" })
		.click();
	await expectToastClear(a.page, "ブロックしました。");
	release();
	await expect(a.page.getByText("このつながりは終了しました")).toBeVisible();
});
