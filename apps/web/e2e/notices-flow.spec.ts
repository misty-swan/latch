/**
 * お知らせ・通報・ブロックの画面のブラウザE2E(F7c計画Task 10・F7c設計 §5.2)。
 * 1本目はdocs/02 §4の#16の画面部分(提案がアプリ内通知に届き、そこから開いて回答できる)を証明する。
 * - 2人はbrowser.newContext()を2つ作り、それぞれUIの実フローで登録する
 * - Intentの投入と相手側の回答はAPIで行う(投入・回答の画面はflow.spec.ts・latch-flow.spec.tsで証明済み)
 * - 地域はweb専用のsite 44・45・46(latch-flow.spec.tsの40・41/chat-flow.spec.tsの42・43と分ける)
 * - プッシュの購読はE2Eに含めない(F7c設計 §5.2: 実際のプッシュサービスへ通信し結果が揺れるため)
 */

import { expect, type Page, test } from "@playwright/test";
import {
	answerYesViaApi,
	establishLatch,
	expireLeftoverE2eIntents,
	fetchDevReports,
	proposeLatch,
	waitForDevLatch,
} from "./helpers";

const NAME_A = "E2Eあさひ";
const NAME_B = "E2Eゆうひ";

/** お知らせ一覧の既読(POST /v1/notifications/read)の完了を待つPromiseを先に作る */
const watchNoticesRead = (page: Page) =>
	page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === "/v1/notifications/read" &&
			r.request().method() === "POST",
	);

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("提案がお知らせに届き、そこから回答でき、成立もお知らせからチャットへ開ける(#16の画面部分)", async ({
	browser,
}) => {
	const { a, b, latchId, intentId } = await proposeLatch(browser, 44, [
		NAME_A,
		NAME_B,
	]);

	// A: ホームのベルに未読1件(新規ユーザーのため、届いているのはこの提案の1件だけ)
	await a.page.goto("/home");
	const bellUnread = a.page.getByRole("link", { name: "お知らせ(未読1件)" });
	await expect(bellUnread).toBeVisible();

	// ベル→お知らせ一覧→「提案が届いています」→提案画面で[参加する]
	const readProposal = watchNoticesRead(a.page);
	await bellUnread.click();
	await expect(a.page).toHaveURL(/\/notices$/);
	const proposalRow = a.page.getByRole("link", { name: /提案が届いています/ });
	await expect(proposalRow).toBeVisible();
	await readProposal;
	await proposalRow.click();
	await expect(a.page).toHaveURL(new RegExp(`/latches/${latchId}$`));
	await expect(
		a.page.getByRole("heading", { name: /条件が合う候補が\s*あります。/ }),
	).toBeVisible();
	await a.page.getByRole("button", { name: "参加する" }).click();
	await expect(
		a.page.getByRole("heading", { name: /相手の回答を\s*待っています。/ }),
	).toBeVisible();

	// B: APIでyes→成立
	await answerYesViaApi([b], latchId);
	await waitForDevLatch(
		a.page,
		a.token,
		intentId,
		(item) => item.status === "matched",
	);

	// A: お知らせを開き直すと「E2Eゆうひさんとつながりました」→押すとチャット
	const readMatched = watchNoticesRead(a.page);
	await a.page.goto("/notices");
	const matchedRow = a.page.getByRole("link", {
		name: new RegExp(`${NAME_B}さんとつながりました`),
	});
	await expect(matchedRow).toBeVisible();
	// 既読の完了を待ってから離れる(中断されると未読が残るため)
	await readMatched;
	await matchedRow.click();
	await expect(a.page).toHaveURL(new RegExp(`/latches/${latchId}/chat$`));
	await expect(
		a.page.getByRole("textbox", { name: "メッセージ" }),
	).toBeVisible();

	// ホームのベルは未読なし。未読の取得(GET /v1/notifications)の応答を待ってから確かめる
	// (応答前の初期表示も「お知らせ」のため、待たないと確認が空振りする)
	const unreadLoaded = a.page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === "/v1/notifications" &&
			r.request().method() === "GET" &&
			r.status() === 200,
	);
	await a.page.goto("/home");
	await unreadLoaded;
	await expect(
		a.page.getByRole("link", { name: "お知らせ", exact: true }),
	).toBeVisible();
	await expect(a.page.getByRole("link", { name: /未読\d+件/ })).toHaveCount(0);
	// APIでも未読0件
	const listRes = await a.page.request.get("/v1/notifications", {
		headers: { authorization: `Bearer ${a.token}` },
	});
	expect(listRes.status(), "GET /v1/notifications").toBe(200);
	expect(
		((await listRes.json()) as { unread_count: number }).unread_count,
	).toBe(0);
});

test("提案とチャットの相手の発言を通報すると、記録に残る", async ({
	browser,
}) => {
	const { a, b, latchId, intentId } = await proposeLatch(browser, 45, [
		NAME_A,
		NAME_B,
	]);

	// A: 提案の「…」→この提案を通報する→理由→[通報する]
	await a.page.goto(`/latches/${latchId}`);
	await a.page.getByRole("button", { name: "この提案について" }).click();
	await a.page
		.getByRole("dialog", { name: "この提案について" })
		.getByRole("link", { name: "この提案を通報する" })
		.click();
	await expect(a.page).toHaveURL(new RegExp(`/latches/${latchId}/report$`));
	await a.page.getByRole("radio", { name: "スパム・勧誘" }).check();
	await a.page.getByRole("button", { name: "通報する" }).click();
	await expect(a.page.getByText("通報を受け付けました。")).toBeVisible();

	// 2人ともAPIでyes→成立。BがAPIで1通送る
	await answerYesViaApi([a, b], latchId);
	await waitForDevLatch(
		a.page,
		a.token,
		intentId,
		(item) => item.status === "matched",
	);
	const sendRes = await b.page.request.post(`/v1/latches/${latchId}/messages`, {
		data: { body: "通報される発言", client_id: crypto.randomUUID() },
		headers: { authorization: `Bearer ${b.token}` },
	});
	expect(sendRes.status(), "POST /v1/latches/{id}/messages").toBe(201);
	const sent = (await sendRes.json()) as { id: string };

	// A: チャットの相手の発言→このメッセージの操作→このメッセージを通報する→引用つきの通報画面
	await a.page.goto(`/latches/${latchId}/chat`);
	await expect(
		a.page.locator(".msg--theirs .msg__bubble", { hasText: "通報される発言" }),
	).toBeVisible();
	await a.page.getByRole("button", { name: "このメッセージの操作" }).click();
	await a.page
		.getByRole("dialog", { name: "このメッセージについて" })
		.getByRole("button", { name: "このメッセージを通報する" })
		.click();
	await expect(a.page).toHaveURL(
		new RegExp(`/latches/${latchId}/report\\?message=`),
	);
	await expect(a.page.locator(".report-quote")).toHaveText("通報される発言");
	await a.page.getByRole("radio", { name: "嫌がらせ" }).check();
	await a.page.getByRole("button", { name: "通報する" }).click();
	await expect(a.page.getByText("通報を受け付けました。")).toBeVisible();

	// 記録: 提案の通報(target=proposal・対象者=B)と発言の通報(target=message・message_id一致)
	const meRes = await b.page.request.get("/v1/users/me", {
		headers: { authorization: `Bearer ${b.token}` },
	});
	expect(meRes.status(), "GET /v1/users/me").toBe(200);
	const bUserId = ((await meRes.json()) as { id: string }).id;
	const reports = (await fetchDevReports(a.page, a.token)).filter(
		(r) => r.latch_id === latchId,
	);
	expect(
		reports.filter(
			(r) =>
				r.target === "proposal" &&
				r.reason === "spam" &&
				r.reportee === bUserId,
		),
	).toHaveLength(1);
	expect(
		reports.filter(
			(r) =>
				r.target === "message" &&
				r.reason === "harassment" &&
				r.message_id === sent.id &&
				r.reportee === bUserId,
		),
	).toHaveLength(1);
});

test("1対1のチャットでブロックすると、自分の一覧に相手が出て、相手は読み取り専用になる", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 46, [NAME_A, NAME_B]);
	await a.page.goto(`/latches/${latchId}/chat`);
	await expect(
		a.page.getByRole("textbox", { name: "メッセージ" }),
	).toBeVisible();

	// A: このつながりについて→ブロックする→確認→[ブロックする]
	await a.page.getByRole("button", { name: "このつながりについて" }).click();
	await a.page
		.getByRole("dialog", { name: "このつながりについて" })
		.getByRole("button", { name: "ブロックする" })
		.click();
	const confirm = a.page.getByRole("dialog", { name: "ブロックの確認" });
	await expect(
		confirm.getByRole("heading", {
			name: `${NAME_B}さんを、ブロックしますか。`,
		}),
	).toBeVisible();
	await confirm.getByRole("button", { name: "ブロックする" }).click();
	await expect(a.page.getByText("このつながりは終了しました")).toBeVisible();

	// A: ブロックしたユーザーに相手の表示名
	await a.page.goto("/settings/blocked");
	await expect(a.page.getByText(NAME_B)).toBeVisible();

	// B: チャットは終了の帯が出て入力欄が無い
	await b.page.goto(`/latches/${latchId}/chat`);
	await expect(b.page.getByText("このつながりは終了しました")).toBeVisible();
	await expect(b.page.getByRole("textbox", { name: "メッセージ" })).toHaveCount(
		0,
	);
});
