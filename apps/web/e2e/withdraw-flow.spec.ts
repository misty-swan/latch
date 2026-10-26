/**
 * 退会の画面のブラウザE2E(LAT-94・docs/10 §4のF9の退会の試験)。
 * 2人の成立(matched)まではAPIで進め(回答の画面はlatch-flow.spec.tsで証明済み)、
 * 「自分」→ヘルプ・お問い合わせ→退会の確認の段→本人確認→はじめの画面の一言までを画面で通し、
 * 相手のチャットが終了(読み取り専用)になることを確かめる。地域はweb専用のsite 48
 */

import { expect, test } from "@playwright/test";
import { establishLatch, expireLeftoverE2eIntents } from "./helpers";

const NAME_A = "E2Eみさき";
const NAME_B = "E2Eはるか";

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("「自分」から退会すると、はじめの画面に戻り、相手のチャットは終了になる", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 48, [NAME_A, NAME_B]);

	// A: 退会の前にひとこと送っておく(相手の側に残る)
	await a.page.goto(`/latches/${latchId}/chat`);
	await a.page
		.getByRole("textbox", { name: "メッセージ" })
		.fill("またどこかで");
	await a.page.getByRole("button", { name: "送る" }).click();
	await expect(
		a.page.locator(".msg--mine .msg__bubble", { hasText: "またどこかで" }),
	).toBeVisible();

	// A: 自分→ヘルプ・お問い合わせ(案内のページ)→戻る
	await a.page.goto("/me");
	await a.page.getByRole("link", { name: "ヘルプ・お問い合わせ" }).click();
	await expect(
		a.page.getByRole("heading", { level: 1, name: "ヘルプ・お問い合わせ" }),
	).toBeVisible();
	await a.page.getByRole("button", { name: "戻る" }).click();
	await expect(a.page).toHaveURL(/\/me$/);

	// A: 退会する→確認の段→やめるで戻れる
	await a.page.getByRole("link", { name: "退会する" }).click();
	await expect(
		a.page.getByRole("heading", { name: "退会の前に。" }),
	).toBeVisible();
	await a.page.getByRole("link", { name: "やめる" }).click();
	await expect(a.page).toHaveURL(/\/me$/);

	// A: もう一度入り、本人確認(サインインと同じ名前)で退会する
	await a.page.getByRole("link", { name: "退会する" }).click();
	await a.page
		.getByRole("button", { name: "Googleで確かめて退会する" })
		.click();
	await a.page.getByLabel("サインインに使った名前").fill(a.subject);
	await a.page
		.getByRole("button", { name: "確かめて退会する", exact: true })
		.click();
	await expect(a.page).toHaveURL(/\/welcome$/);
	await expect(a.page.getByText("退会しました。")).toBeVisible();
	// 端末のセッションは消えている(保護された画面ははじめの画面へ戻される)
	await a.page.goto("/home");
	await expect(a.page).toHaveURL(/\/welcome$/);

	// B: チャットは終了(読み取り専用)・相手の名前は出ず、メッセージは残る
	await b.page.goto(`/latches/${latchId}/chat`);
	await expect(b.page.getByText("このつながりは終了しました")).toBeVisible();
	await expect(
		b.page.locator(".msg--theirs .msg__bubble", { hasText: "またどこかで" }),
	).toBeVisible();
	await expect(b.page.getByText(NAME_A)).toHaveCount(0);
	await expect(b.page.getByRole("textbox", { name: "メッセージ" })).toHaveCount(
		0,
	);
});
