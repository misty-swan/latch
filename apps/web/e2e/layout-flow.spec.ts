/**
 * 画面の枠の高さのブラウザE2E(LAT-111)。iPhoneの大きさ(390x844)で、
 * 画面の枠(.screen)と紙の質感(.grain)が画面の高さちょうどに収まり、中身は .screen__body の
 * 内側でスクロールし、上の帯と下の操作が見えたままであることを確かめる。
 * 枠に上限が無いと、長い画面(規約・プライバシー・長い会話)で枠が中身の長さまで伸び、
 * 質感を全面に描き直してiPhoneで切り替えが重くなる。
 * 「自分」から規約・プライバシー・ヘルプへの移動が画面内の切り替え(ページ全体の読み直しなし)で
 * あることも確かめる。地域はweb専用のsite 49
 */

import { expect, type Page, test } from "@playwright/test";
import {
	composeAndRead,
	establishLatch,
	expireLeftoverE2eIntents,
	placeAndBackToHome,
	signIn,
} from "./helpers";

const IPHONE = { width: 390, height: 844 };

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

/** 枠と質感が画面の高さちょうどで、文書全体はスクロールしない */
const expectBoundedScreen = async (page: Page): Promise<void> => {
	const m = await page.evaluate(() => {
		const screen = document.querySelector(".screen");
		const grain = document.querySelector(".grain rect");
		return {
			viewport: window.innerHeight,
			doc: document.documentElement.scrollHeight,
			screen: screen?.getBoundingClientRect().height ?? -1,
			grain: grain?.getBoundingClientRect().height ?? -1,
		};
	});
	expect(Math.round(m.screen), "画面の枠の高さ").toBe(m.viewport);
	expect(Math.round(m.grain), "紙の質感の高さ").toBe(m.viewport);
	expect(m.doc, "文書全体の高さ").toBeLessThanOrEqual(m.viewport);
	await expect(page.locator(".topbar").first()).toBeInViewport({ ratio: 1 });
};

/** 中身を .screen__body の最後までスクロールしても、上の帯は見えたままで文書は動かない */
const expectInnerScroll = async (page: Page): Promise<void> => {
	const body = page.locator(".screen__body");
	const scrolled = await body.evaluate((el) => {
		const overflow = el.scrollHeight > el.clientHeight;
		el.scrollTop = el.scrollHeight;
		return { overflow, top: el.scrollTop };
	});
	expect(scrolled.overflow, "中身が枠より長い").toBe(true);
	expect(scrolled.top, "枠の内側でスクロールした").toBeGreaterThan(0);
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	await expect(page.locator(".topbar").first()).toBeInViewport({ ratio: 1 });
};

test("登録・同意の後の画面・預けている一覧・意思の詳細・規約・プライバシー・ヘルプが画面の高さに収まる", async ({
	page,
}) => {
	await page.setViewportSize(IPHONE);
	await signIn(page);

	// Register(formで本文と下の操作を包む画面)。下の操作が見えている
	await expectBoundedScreen(page);
	await expect(page.getByRole("button", { name: "次へ" })).toBeInViewport();
	await page.locator("#r-name").fill("E2Eレイアウト");
	await page.locator("#r-birth").fill("2000-01-01");
	await page.getByRole("button", { name: "次へ" }).click();
	await page.getByRole("button", { name: "同意して進む" }).click();

	// Compose
	await expect(page.locator("#c-text")).toBeVisible();
	await expectBoundedScreen(page);
	await expect(page.getByRole("button", { name: "読み解く" })).toBeInViewport();
	await page.getByRole("link", { name: "閉じる" }).click();

	// Home→意思を1件預けて詳細へ
	await expect(page.getByText("まだ、何も置いていません。")).toBeVisible();
	await expectBoundedScreen(page);
	const words = "週末に一緒に走れる仲間が欲しい";
	await composeAndRead(page, words);
	const card = await placeAndBackToHome(page, words);
	await expectBoundedScreen(page);
	await card.click();
	await expect(page).toHaveURL(/\/intents\//);
	await expectBoundedScreen(page);

	// 自分→3ページ。画面内の切り替えで、ページ全体の読み直しは起きない
	for (const [name, long] of [
		["ヘルプ・お問い合わせ", false],
		["利用規約", true],
		["プライバシーポリシー", true],
	] as const) {
		await page.goto("/me");
		await expect(page.locator(".me__card")).toBeVisible();
		await expectBoundedScreen(page);
		await page.evaluate(() => {
			(window as unknown as { __sameDocument: boolean }).__sameDocument = true;
		});
		await page.getByRole("link", { name }).click();
		await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __sameDocument?: boolean }).__sameDocument,
			),
			"ページ全体の読み直しが起きていない",
		).toBe(true);
		await expectBoundedScreen(page);
		if (long) await expectInnerScroll(page);
		await page.getByRole("button", { name: "戻る" }).click();
		await expect(page).toHaveURL(/\/me$/);
	}
});

test("長い会話のチャットは画面の高さに収まり、開くと最下部が見え、送った発言も見える", async ({
	browser,
}) => {
	const { a, latchId } = await establishLatch(browser, 49, [
		"E2Eあおい",
		"E2Eそら",
	]);

	// 画面より長い会話をAPIで作る(送る画面はchat-flow.spec.tsで証明済み)
	for (let i = 1; i <= 40; i++) {
		const res = await a.page.request.post(`/v1/latches/${latchId}/messages`, {
			data: { body: `長い会話の${i}通目`, client_id: `e2e-layout-${i}` },
			headers: { authorization: `Bearer ${a.token}` },
		});
		expect(res.status(), "POST /v1/latches/{id}/messages").toBe(201);
	}

	await a.page.setViewportSize(IPHONE);
	await a.page.goto(`/latches/${latchId}/chat`);
	const last = a.page.locator(".msg__bubble", { hasText: "長い会話の40通目" });
	await expect(last).toBeVisible();
	await expectBoundedScreen(a.page);
	await expect(last).toBeInViewport();
	const textbox = a.page.getByRole("textbox", { name: "メッセージ" });
	await expect(textbox).toBeInViewport();

	await textbox.fill("いちばん下に出る");
	await a.page.getByRole("button", { name: "送る" }).click();
	await expect(
		a.page.locator(".msg--mine .msg__bubble", { hasText: "いちばん下に出る" }),
	).toBeInViewport();
	await expectBoundedScreen(a.page);
});
