/**
 * PC向けの画面のブラウザE2E(LAT-14・PC向けの画面の設計)。PCの大きさ(1280×800)で、
 * 画面が横いっぱいに伸びず、prototype/project/Desktop.dc.html と承認済みのPC向けのデザインどおりに
 * 出ることを確かめる。
 * - ログイン前: ようこそはPCの2列、サインインはスマホの見た目のまま中央の列(幅480px)
 * - ログイン後: 左のナビ+中央の列(幅688px)。スマホの下部タブと右上の入口は出さない
 * - 預けている: 右に提案の部屋。提案が無ければ消灯、届けば灯りがともり、部屋の中で参加できる
 * - チャット: 左につながりの一覧を並べる
 * 提案はweb専用のsite 52・53(他のspecの10〜51と分ける)で作る。各testの前後でE2EユーザーのactiveなIntentを倒す。
 * 環境変数 LATCH_DESKTOP_SHOTS にフォルダを渡すと、見た目の確認用のスクリーンショットをそこへ保存する
 */

import { expect, type Page, test } from "@playwright/test";
import {
	establishLatch,
	expireLeftoverE2eIntents,
	proposeLatch,
	signInAndRegister,
} from "./helpers";

const DESKTOP = { width: 1280, height: 800 };
/** 中央の列の幅(desktop.cssの--desk-col) */
const COLUMN = { nav: 688, narrow: 480 };

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

const shot = async (page: Page, name: string): Promise<void> => {
	const dir = process.env.LATCH_DESKTOP_SHOTS;
	if (!dir) return;
	// 画面に入るときの動き(rise・reveal)が終わってから撮る
	await page.waitForTimeout(2500);
	await page.screenshot({ path: `${dir}/${name}.png` });
};

/** 文書が横にも縦にもはみ出さない(横スクロールが出ない) */
const expectNoPageScroll = async (page: Page): Promise<void> => {
	const m = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
		docWidth: document.documentElement.scrollWidth,
		docHeight: document.documentElement.scrollHeight,
	}));
	expect(m.docWidth, "文書の幅").toBeLessThanOrEqual(m.width);
	expect(m.docHeight, "文書の高さ").toBeLessThanOrEqual(m.height);
};

/** 中身(.screen__body)が中央の列の幅に収まり、列の中央に置かれている */
const expectColumn = async (
	page: Page,
	scope: string,
	column: number,
): Promise<void> => {
	// 画面の切り替えはURLが先に変わり、中身の描画が後から来るため、中身が出るのを待ってから測る
	await expect(page.locator(`${scope} .screen__body`).first()).toBeVisible();
	const m = await page.evaluate((selector) => {
		const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
		const main = box(document.querySelector(selector));
		const body = box(document.querySelector(`${selector} .screen__body`));
		return { main, body };
	}, scope);
	expect(m.main, "中央の列").not.toBeNull();
	expect(m.body, "画面の中身").not.toBeNull();
	if (!m.main || !m.body) return;
	expect(Math.round(m.body.width), "中身の幅").toBeLessThanOrEqual(column);
	const leftGap = m.body.left - m.main.left;
	const rightGap = m.main.right - m.body.right;
	expect(Math.abs(leftGap - rightGap), "列の中央に置かれている").toBeLessThan(
		2,
	);
};

test("ログイン前: ようこそはPCの2列で、サインインは中央の列に収まる", async ({
	page,
}) => {
	await page.setViewportSize(DESKTOP);
	await page.goto("/welcome");
	await expect(
		page.getByRole("heading", { level: 1, name: "探さなくていい。" }),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: /置いておけばいい。/ }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "はじめる" })).toBeInViewport();
	await expect(page.getByRole("navigation", { name: "メイン" })).toHaveCount(0);
	await expectNoPageScroll(page);
	await shot(page, "01-welcome");

	await page.getByRole("link", { name: "アカウントをお持ちの方" }).click();
	await expect(page).toHaveURL(/\/signin$/);
	await expectColumn(page, ".desk__main", COLUMN.narrow);
	await expectNoPageScroll(page);
	await shot(page, "02-signin");
});

test("ログイン後: 左のナビ・中央の列・消灯した提案の部屋が出て、ナビで画面を移れる", async ({
	browser,
}) => {
	const context = await browser.newContext({ viewport: DESKTOP });
	const page = await context.newPage();
	await signInAndRegister(page, "E2Eデスク");

	// 預けている(空): 左のナビ・中央の列・右の部屋(消灯)
	await expect(page.getByText("まだ、何も置いていません。")).toBeVisible();
	const nav = page.getByRole("navigation", { name: "メイン" });
	await expect(nav).toBeVisible();
	await expect(
		nav.getByRole("link", { name: "預けている", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await expect(nav.getByText("E2Eデスク")).toBeVisible();
	await expect(page.locator(".tabbar")).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: "自分", exact: true }),
	).toHaveCount(0);
	const room = page.getByRole("complementary", { name: "提案の部屋" });
	await expect(room).toBeVisible();
	await expect(room.getByText("いまは、届いている提案は")).toBeVisible();
	await expectColumn(page, ".desk__main", COLUMN.nav);
	await expectNoPageScroll(page);
	await shot(page, "03-home-quiet");

	// つながり
	await nav.getByRole("link", { name: "つながり", exact: true }).click();
	await expect(page).toHaveURL(/\/connections$/);
	await expect(
		nav.getByRole("link", { name: "つながり", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("complementary")).toHaveCount(0);
	await expectColumn(page, ".desk__main", COLUMN.nav);
	await expectNoPageScroll(page);

	// 置く(書きかけの文は、幅を変えても消えない)
	await nav.getByRole("link", { name: "ひとこと置く" }).click();
	await expect(page).toHaveURL(/\/compose$/);
	await page.locator("#c-text").fill("週末に一緒に走れる仲間が欲しい");
	await expectColumn(page, ".desk__main", COLUMN.nav);
	await expect(page.getByRole("button", { name: "読み解く" })).toBeInViewport();
	await expectNoPageScroll(page);
	await shot(page, "04-compose");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(nav).toHaveCount(0);
	await expect(page.locator("#c-text")).toHaveValue(
		"週末に一緒に走れる仲間が欲しい",
	);
	await page.setViewportSize(DESKTOP);
	await expect(nav).toBeVisible();
	await expect(page.locator("#c-text")).toHaveValue(
		"週末に一緒に走れる仲間が欲しい",
	);

	// 自分
	await nav.getByRole("link", { name: /自分・設定/ }).click();
	await expect(page).toHaveURL(/\/me$/);
	await expectNoPageScroll(page);
	await context.close();
});

test("提案が届くと右の部屋に灯りがともり、部屋の中で参加できる", async ({
	browser,
}) => {
	const { a } = await proposeLatch(browser, 52, ["E2Eひかり", "E2Eともる"]);
	await a.page.setViewportSize(DESKTOP);
	await a.page.goto("/home");

	await expect(
		a.page.getByRole("link", { name: /提案が届いています/ }),
	).toContainText("右に表示中");
	const room = a.page.getByRole("complementary", { name: "届いた提案" });
	await expect(
		room.getByRole("heading", { name: /条件が合う候補が\s*あります。/ }),
	).toBeVisible();
	await expectNoPageScroll(a.page);
	await shot(a.page, "05-home-proposal");

	await room.getByRole("button", { name: "参加する" }).click();
	await expect(
		room.getByRole("heading", { name: /相手の回答を\s*待っています。/ }),
	).toBeVisible();
	await expect(a.page).toHaveURL(/\/home$/);
	await expect(
		a.page.getByRole("link", { name: /相手の回答を待っています/ }),
	).toContainText("右に表示中");
	await shot(a.page, "06-home-awaiting");
});

test("チャットは左につながりの一覧を並べ、会話は中央の列に収まる", async ({
	browser,
}) => {
	const { a, latchId } = await establishLatch(browser, 53, [
		"E2Eならび",
		"E2Eとなり",
	]);
	await a.page.setViewportSize(DESKTOP);
	await a.page.goto(`/latches/${latchId}/chat`);

	const list = a.page.locator(".desk__list");
	await expect(
		list.getByRole("heading", { level: 1, name: "つながり" }),
	).toBeVisible();
	await expect(list.getByText("E2Eとなり")).toBeVisible();
	const textbox = a.page.getByRole("textbox", { name: "メッセージ" });
	await expect(textbox).toBeInViewport();
	await textbox.fill("広い画面からこんにちは");
	await a.page.getByRole("button", { name: "送る" }).click();
	await expect(
		a.page.locator(".msg--mine .msg__bubble", {
			hasText: "広い画面からこんにちは",
		}),
	).toBeInViewport();
	await expectColumn(a.page, ".desk__main", COLUMN.nav);
	await expectNoPageScroll(a.page);
	await shot(a.page, "07-chat");
});
