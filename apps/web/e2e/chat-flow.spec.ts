/**
 * チャットの画面のブラウザE2E(F6b計画Task 9)。
 * 2人はbrowser.newContext()を2つ作り、成立(matched)まではAPIで進めて(回答の画面は
 * latch-flow.spec.tsで証明済み)、チャット・一覧・離脱・表示削除を画面で確かめる。
 * 地域はweb専用のsite 42・43(latch-flow.spec.tsの40・41と分ける)
 */

import { expect, type Page, test } from "@playwright/test";
import { establishLatch, expireLeftoverE2eIntents } from "./helpers";

const NAME_A = "E2Eあさひ";
const NAME_B = "E2Eゆうひ";

/** 既読の前進(POST /v1/latches/{id}/read)の完了を待つPromiseを先に作る(離れる前に完了させ中断を防ぐ) */
const watchRead = (page: Page, latchId: string) =>
	page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === `/v1/latches/${latchId}/read` &&
			r.request().method() === "POST",
	);

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("2人が画面で送り合い、一覧に最終メッセージと未読が出る", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 42, [NAME_A, NAME_B]);

	// A: つながりました→[メッセージを送る]→チャット。Bは先にチャットを開いておく
	await a.page.goto(`/latches/${latchId}`);
	await expect(
		a.page.getByRole("heading", { name: "つながりました。" }),
	).toBeVisible();
	await a.page.getByRole("link", { name: "メッセージを送る" }).click();
	await expect(a.page).toHaveURL(new RegExp(`/latches/${latchId}/chat$`));
	await b.page.goto(`/latches/${latchId}/chat`);
	await expect(b.page.getByLabel("メッセージ")).toBeVisible();

	// A送信→Bに再読み込みなしで出る
	await a.page.getByLabel("メッセージ").fill("はじめまして");
	await a.page.getByRole("button", { name: "送る" }).click();
	await expect(
		a.page.locator(".msg--mine .msg__bubble", { hasText: "はじめまして" }),
	).toBeVisible();
	await expect(
		b.page.locator(".msg--theirs .msg__bubble", { hasText: "はじめまして" }),
	).toBeVisible();

	// B返信→Aに出る
	const readAfterReply = watchRead(a.page, latchId);
	await b.page.getByLabel("メッセージ").fill("こちらこそ");
	await b.page.getByRole("button", { name: "送る" }).click();
	await expect(
		a.page.locator(".msg--theirs .msg__bubble", { hasText: "こちらこそ" }),
	).toBeVisible();

	// 既読の前進が完了してから離れる(中断されると未読が2件になるため)
	await readAfterReply;
	// Aは一覧へ移り、Bがもう1通送る→Aの一覧を再表示すると最終メッセージと未読1件
	await a.page.goto("/connections");
	await expect(
		a.page.getByRole("heading", { name: "つながっている" }),
	).toBeVisible();
	await b.page.getByLabel("メッセージ").fill("また明日");
	await b.page.getByRole("button", { name: "送る" }).click();
	await expect(
		b.page.locator(".msg--mine .msg__bubble", { hasText: "また明日" }),
	).toBeVisible();
	await a.page.goto("/connections");
	const row = a.page.locator(".conn", { hasText: NAME_B });
	await expect(row).toContainText("また明日");
	await expect(row.getByLabel("未読1件")).toBeVisible();

	// 行を押してチャットを開き、一覧へ戻ると未読表示が消える
	const readAfterOpen = watchRead(a.page, latchId);
	await row.click();
	await expect(a.page).toHaveURL(new RegExp(`/latches/${latchId}/chat$`));
	await expect(
		a.page.locator(".msg--theirs .msg__bubble", { hasText: "また明日" }),
	).toBeVisible();
	await readAfterOpen;
	await a.page.goto("/connections");
	const rowAfter = a.page.locator(".conn", { hasText: NAME_B });
	await expect(rowAfter).toBeVisible();
	await expect(rowAfter.getByLabel(/未読\d+件/)).toHaveCount(0);
});

test("参加を取り消すと相手は読み取り専用になり、表示から消すと一覧から消える", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 43, [NAME_A, NAME_B]);
	await a.page.goto(`/latches/${latchId}/chat`);
	await b.page.goto(`/latches/${latchId}/chat`);
	await expect(a.page.getByLabel("メッセージ")).toBeVisible();
	await expect(b.page.getByLabel("メッセージ")).toBeVisible();

	// A: このつながりについて→参加を取り消す→[取り消す]
	await a.page.getByRole("button", { name: "このつながりについて" }).click();
	const menuA = a.page.getByRole("dialog", { name: "このつながりについて" });
	await menuA.getByRole("button", { name: "参加を取り消す" }).click();
	await a.page.getByRole("button", { name: "取り消す", exact: true }).click();
	await expect(a.page.getByText("このつながりは終了しました")).toBeVisible();

	// B: 再読み込みなしでclosed(入力欄が消え・終了の帯が出る)
	await expect(b.page.getByText("このつながりは終了しました")).toBeVisible();
	await expect(b.page.getByLabel("メッセージ")).toHaveCount(0);

	// B: 一覧の「終了」に「つながっていた相手」
	await b.page.goto("/connections");
	await expect(b.page.getByRole("heading", { name: "終了" })).toBeVisible();
	const ended = b.page.locator(".conn", { hasText: "つながっていた相手" });
	await expect(ended).toBeVisible();

	// B: チャットから「表示から消す」→[消す]→一覧に行が無くトースト
	await ended.click();
	await b.page.getByRole("button", { name: "このつながりについて" }).click();
	const menuB = b.page.getByRole("dialog", { name: "このつながりについて" });
	await menuB.getByRole("button", { name: "表示から消す" }).click();
	await b.page.getByRole("button", { name: "消す", exact: true }).click();
	await expect(b.page.getByText("一覧から消しました。")).toBeVisible();
	await expect(
		b.page.locator(".conn", { hasText: "つながっていた相手" }),
	).toHaveCount(0);
});
