/**
 * 提案への回答の画面のブラウザE2E(F4c計画Task 8・docs/02 §4の#17のUI部分=F4cのゲート)。
 * 2人の回答をUIの2択(yes=[参加する] / defer=[今回は見送る]・noは画面に置かない)で行い、
 * 画面の切り替わりと記録(dev観測APIのLATCHのstatus)を確かめる。
 * - 2人はbrowser.newContext()を2つ作り、それぞれUIの実フローで登録する
 * - Intentの投入はAPIで行う(ゲートの対象は回答の画面・投入画面はflow.spec.tsで証明済み)。
 *   stub Jevは全軸0.9のため、同じtopic・同じ地域のつながりIntentの2人は必ず提案される
 * - 地域はweb専用のsite 40・41(worker E2Eの残りと混ざらない)・topicはtestごとに一意。
 *   各testの前にE2EユーザーのactiveなIntentをexpiredへ倒す(提案の枠を残りが埋めないため)
 * - 回答待ちの側の取り直しはTanStack Query v5のfocusManager(windowのvisibilitychange)で起こす
 *   (30秒ごとの再取得を待たない)
 */

import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createConnectionIntent,
	expireLeftoverE2eIntents,
	setUpUser,
	waitForDevLatch,
} from "./helpers";

const NAME_A = "E2Eあさひ";
const NAME_B = "E2Eゆうひ";

/** 見出しの改行(<br>)はアクセシブルネームで空白になるため、空白の有無を問わず照合する */
const AWAITING_HEADING = /相手の回答を\s*待っています。/;

/** 2人を登録し・同じtopic・同じ地域のつながりIntentを投入して提案まで待つ */
const setUpProposal = async (
	browser: Browser,
	site: number,
): Promise<{
	a: { page: Page; token: string };
	b: { page: Page; token: string };
	intentId: string;
}> => {
	const a = await setUpUser(browser, NAME_A);
	const b = await setUpUser(browser, NAME_B);
	// topicは40文字上限(LIMITS.TOPIC_MAX_LENGTH)のため、UUIDの先頭8桁で一意にする
	const topic = `e2e-web-latch-${crypto.randomUUID().slice(0, 8)}`;
	const intentA = await createConnectionIntent(a.page, a.token, topic, site);
	await createConnectionIntent(b.page, b.token, topic, site);
	await waitForDevLatch(
		a.page,
		a.token,
		intentA.id,
		(item) => item.status === "proposed",
	);
	return { a, b, intentId: intentA.id };
};

/** Homeの到着カード(提案が届いています)から提案画面へ入る */
const openArrival = async (page: Page): Promise<void> => {
	await page.goto("/home");
	await page.getByRole("link", { name: /提案が届いています/ }).click();
	await expect(
		page.getByRole("heading", { name: /条件が合う候補が\s*あります。/ }),
	).toBeVisible();
};

/** 回答待ちの側を前面に戻し・visibilitychangeで取り直させる */
const refetchByFocus = async (page: Page): Promise<void> => {
	await page.bringToFront();
	await page.evaluate(() =>
		window.dispatchEvent(new Event("visibilitychange")),
	);
};

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

// 後片付け: 作成したIntentを残すと、次回のflow.spec.ts(地域なし=全国スコープ)の
// Intentと提案されて画面の検証を乱すため、各testの後にも倒す
test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("2人が画面から参加すると成立し、待っていた側も切り替わる(#17)", async ({
	browser,
}) => {
	const { a, b, intentId } = await setUpProposal(browser, 40);

	// A: 到着カード→提案画面。回答のボタンは2択だけ(noは画面に置かない)。
	// 画面全体のボタンは、右上の「この提案について」(F7cの通報の入口・回答ではない)を
	// 唯一の例外として、DOM順に[この提案について, 参加する, 今回は見送る]の3つだけ
	await openArrival(a.page);
	const buttons = a.page.getByRole("button");
	await expect(buttons).toHaveCount(3);
	await expect(buttons.nth(0)).toHaveAccessibleName("この提案について");
	await expect(buttons.nth(1)).toHaveAccessibleName("参加する");
	await expect(buttons.nth(2)).toHaveAccessibleName("今回は見送る");
	await a.page.getByRole("button", { name: "参加する" }).click();
	await expect(
		a.page.getByRole("heading", { name: AWAITING_HEADING }),
	).toBeVisible();

	// B: 到着カードから[参加する]→成立。相手(A)の表示名が出る
	await openArrival(b.page);
	await b.page.getByRole("button", { name: "参加する" }).click();
	await expect(
		b.page.getByRole("heading", { name: "つながりました。" }),
	).toBeVisible();
	await expect(b.page.getByText(NAME_A)).toBeVisible();

	// A: 取り直しで成立の画面へ切り替わる
	await refetchByFocus(a.page);
	await expect(
		a.page.getByRole("heading", { name: "つながりました。" }),
	).toBeVisible();
	await expect(a.page.getByText(NAME_B)).toBeVisible();

	await waitForDevLatch(
		a.page,
		a.token,
		intentId,
		(item) => item.status === "matched",
	);
});

test("見送ると見送った画面と説明が出て理由を残せ、相手は成立しませんでした(#17)", async ({
	browser,
}) => {
	const { a, b, intentId } = await setUpProposal(browser, 41);

	await openArrival(a.page);
	await a.page.getByRole("button", { name: "参加する" }).click();
	await expect(
		a.page.getByRole("heading", { name: AWAITING_HEADING }),
	).toBeVisible();

	// B: [今回は見送る]→見送った画面と、つながりIntentの説明(この端末で初回)
	await openArrival(b.page);
	await b.page.getByRole("button", { name: "今回は見送る" }).click();
	await expect(b.page).toHaveURL(/\/latches\/[^/]+\/shelved$/);
	await expect(
		b.page.getByRole("img", { name: "そっと、棚に戻しました。" }),
	).toBeVisible();
	await expect(
		b.page.getByText("この相手との提案は今後届きません。"),
	).toBeVisible();

	// 理由を残す(任意)→1つ選んで[残す]→トースト
	await b.page
		.getByRole("button", { name: "見送った理由を残す(任意)" })
		.click();
	const sheet = b.page.getByRole("dialog", { name: "見送った理由" });
	await sheet.getByRole("radio", { name: "日時や場所が合わない" }).check();
	await sheet.getByRole("button", { name: "残す" }).click();
	await expect(
		b.page.getByRole("status").filter({
			hasText: "ありがとうございます。相手には伝わりません。",
		}),
	).toBeVisible();

	// A: 取り直しで成立しませんでしたへ切り替わる
	await refetchByFocus(a.page);
	await expect(
		a.page.getByText("この提案は成立しませんでした。"),
	).toBeVisible();

	await waitForDevLatch(
		a.page,
		a.token,
		intentId,
		(item) => item.status === "rejected",
	);
});
