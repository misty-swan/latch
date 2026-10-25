/**
 * 画面フローのブラウザE2E(F2'計画Task 8・docs/01 §10の画面フローをchromiumで完走する)。
 * - サインイン〜同意〜預ける〜一覧までをUIの実フローで通す(localStorageへの注入はしない)
 * - stub Parserは決定的(同一入力+同一clock→同一出力・07 §2)のため・読み解き結果の
 *   form判定を期待値として断言できる
 * - 機会のstarts_atは実行時のnow+2時間をJSTの壁時計として動生成する(E2Eは実時間・docs/10 §3)
 * - 待ち合わせは明示セレクタ(expect(locator))のみで行う
 * ユーザーはテストごとに新規登録する(ローカルD1は実行間で永続するため)
 */

import { expect, test } from "@playwright/test";
import {
	composeAndRead,
	expireLeftoverE2eIntents,
	fetchIntentsViaApi,
	jstLocalInputPlusHours,
	placeAndBackToHome,
	signIn,
	signInAndRegister,
	underAgeBirthDate,
} from "./helpers";

// 前のテストが預けた意思が残っていると、新しい意思と提案が作られ「預けている」が崩れる。
// 他のspecと同じく、各テストの前後で残りの意思を期限切れにする(#37)
test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("1. welcome→サインイン→登録→同意→compose→homeの空状態", async ({
	page,
}) => {
	// signInAndRegisterは同意後の着地compose(#c-text)を確認してからhomeへ戻る
	await signInAndRegister(page);
	// homeの空状態(HomeEmpty)に出る
	await expect(page.getByText("まだ、何も置いていません。")).toBeVisible();
	await expect(
		page.getByText("いま、預けている意思はありません。"),
	).toHaveCount(0);
});

test("2. つながりを預ける: 読み解き→主題編集・期限30日→placed→homeに追加", async ({
	page,
}) => {
	await signInAndRegister(page);
	// 先頭の__jev_low__はstub Jevを低値にし提案を作らせない目印(test 4と同じ理由)
	const words =
		"__jev_low__ イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。";
	await composeAndRead(page, words);
	// 時刻語・日付語が無い文章はつながりとして読み解かれる(07 §3)
	await expect(
		page.locator('input[name="form"][value="connection"]'),
	).toBeChecked();

	// 主題を行内編集する(Enterで確定)
	await page.getByRole("button", { name: "主題を直す" }).click();
	await page
		.locator('input[aria-label="主題"]')
		.fill("__jev_low__ 絵を見せ合える仲間");
	await page.keyboard.press("Enter");
	await expect(
		page.locator(".fact__val", { hasText: "絵を見せ合える仲間" }),
	).toBeVisible();

	// 期限は30日を選ぶ
	await page.locator(".pill", { hasText: "30日" }).click();
	await expect(page.locator('input[name="days"][value="30"]')).toBeChecked();

	const card = await placeAndBackToHome(page, words);
	await expect(card.locator(".status")).toContainText("預けている");
	await expect(card.locator(".t-label")).toContainText("つながり");
	await expect(page.getByText("いま、1つの意思を預けています。")).toBeVisible();
});

test("3. 機会を預ける: 日時・予算を入力して保存(機会ラベル・預けている)", async ({
	page,
}) => {
	await signInAndRegister(page);
	// 先頭の__jev_low__はstub Jevを低値にし提案を作らせない目印(test 4と同じ理由)
	const words =
		"__jev_low__ 明日の19時ごろに、ランニング仲間と5km走りたい。予算は3000円くらい。";
	await composeAndRead(page, words);
	// 時刻語(19時)があるため機会として読み解かれる(07 §3)
	await expect(
		page.locator('input[name="form"][value="occasion"]'),
	).toBeChecked();

	// 日時を行内で打ち直す(実行時のnow+2時間・JST。確定はblur)
	await page.getByRole("button", { name: "日時を直す" }).click();
	await page
		.locator('input[aria-label="日時"]')
		.fill(jstLocalInputPlusHours(2));
	await page.getByRole("heading", { name: "こう読み解きました。" }).click();
	await expect(
		page.locator(".fact", { hasText: "日時" }).locator(".fact__val"),
	).toContainText("〜");

	// 予算を行内で打ち直す(Enterで確定)
	await page.getByRole("button", { name: "予算を直す" }).click();
	await page.locator('input[aria-label="予算の上限(円)"]').fill("5000");
	await page.keyboard.press("Enter");
	await expect(page.locator(".fact__val", { hasText: "円以内" })).toContainText(
		"5,000円以内",
	);

	const card = await placeAndBackToHome(page, words);
	await expect(card.locator(".status")).toContainText("預けている");
	await expect(card.locator(".t-label")).toContainText("機会");
	await expect(card.locator(".timeline__labels")).toContainText("開始まで");
});

test("4. form切替: つながり判定を機会へ切り替えて日時を入力して保存", async ({
	page,
}) => {
	await signInAndRegister(page);
	// 時刻語・日付語が無いためつながり判定(飲みは飲酒語でしかない・07 §3)
	// 先頭の__jev_low__はstub Jevを低値にし提案を作らせない目印(topicが先頭から作られる)。
	// 同じスイート内の他の意思との提案で「預けている」が崩れるのを防ぐ
	const words = "__jev_low__ 今度飲みに行く仲間が欲しい";
	await composeAndRead(page, words);
	await expect(
		page.locator('input[name="form"][value="connection"]'),
	).toBeChecked();

	// 機会へ切り替えると日時が必須になる
	await page
		.locator("label.choice__opt", { hasText: "機会として預ける" })
		.click();
	await expect(
		page.locator('input[name="form"][value="occasion"]'),
	).toBeChecked();
	await expect(
		page.locator(".fact", { hasText: "日時" }).locator(".fact__val"),
	).toContainText("未設定");

	// starts_atを入力する(実行時のnow+2時間・JST。確定はblur)
	await page.getByRole("button", { name: "日時を直す" }).click();
	await page
		.locator('input[aria-label="日時"]')
		.fill(jstLocalInputPlusHours(2));
	await page.getByRole("heading", { name: "こう読み解きました。" }).click();
	await expect(
		page.locator(".fact", { hasText: "日時" }).locator(".fact__val"),
	).toContainText("〜");

	const card = await placeAndBackToHome(page, words);
	await expect(card.locator(".status")).toContainText("預けている");
	await expect(card.locator(".t-label")).toContainText("機会");
});

test("5. 下書き: 残す→home→再開して預けるとdraftからactiveになる", async ({
	page,
}) => {
	await signInAndRegister(page);
	// 先頭の__jev_low__はstub Jevを低値にし提案を作らせない目印(test 4と同じ理由)
	const words =
		"__jev_low__ 写真を一緒に撮ってくれる人を探しています。急ぎではありません。";
	await page.getByRole("link", { name: "ひとこと置く" }).click();
	await page.locator("#c-text").fill(words);
	await page.getByRole("button", { name: "下書きに残す" }).click();

	// homeの下書きカード(下書き・期限切れの区分)
	const draftCard = page.locator("a.intent", { hasText: words });
	await expect(draftCard).toBeVisible();
	await expect(draftCard.locator(".status")).toContainText("下書き");

	// 再開すると入力が復元される
	await draftCard.click();
	await expect(page.locator("#c-text")).toHaveValue(words);
	await page.getByRole("button", { name: "読み解く" }).click();
	await expect(
		page.getByRole("heading", { name: "こう読み解きました。" }),
	).toBeVisible();
	const card = await placeAndBackToHome(page, words);
	await expect(card.locator(".status")).toContainText("預けている");
	// active化で下書きの区分から出る
	await expect(page.locator(".list__head")).toHaveCount(0);
});

test("6. 修正: confirmで主題と人数を変えて保存すると反映される", async ({
	page,
}) => {
	await signInAndRegister(page);
	const words = "絵を教えてくれる人を探しています。週末にカフェで。";
	await composeAndRead(page, words);

	// 主題を変更する
	await page.getByRole("button", { name: "主題を直す" }).click();
	await page.locator('input[aria-label="主題"]').fill("週末の絵教室の仲間");
	await page.keyboard.press("Enter");
	await expect(
		page.locator(".fact__val", { hasText: "週末の絵教室の仲間" }),
	).toBeVisible();

	// 人数の上限を2→3へ変える(閉じると「2〜3人」の表示になる)
	await page.getByRole("button", { name: "人数を直す" }).click();
	await page.getByRole("button", { name: "上限を増やす" }).click();
	await page.getByRole("button", { name: "人数を閉じる" }).click();
	await expect(
		page.locator(".fact", { hasText: "人数" }).locator(".fact__val"),
	).toContainText("2〜3人");

	await placeAndBackToHome(page, words);
	// homeのカードは文章と状態を表示する
	const items = await fetchIntentsViaApi(page);
	const saved = items.find((item) => item.raw_text === words);
	expect(saved).toBeDefined();
	expect(saved?.status).toBe("active");
	expect(saved?.topic).toBe("週末の絵教室の仲間");
	expect(saved?.participants.min).toBe(2);
	expect(saved?.participants.max).toBe(3);
});

test("7. 入力検証: 300字を超える文章は入力できない", async ({ page }) => {
	await signInAndRegister(page);
	await page.getByRole("link", { name: "ひとこと置く" }).click();
	// 上限(300字)を1字超える入力はmaxlengthで切り詰められる
	await page.locator("#c-text").fill(`あ${"あ".repeat(300)}`);
	const value = await page.locator("#c-text").inputValue();
	expect(value.length).toBe(300);
	// カウンタは上限到達の表示になる
	await expect(page.locator(".counter")).toHaveText("300 / 300");
});

test("8. 入力検証: 17歳の生年月日では登録できず案内に切り替わる", async ({
	page,
}) => {
	await signIn(page);
	await page.locator("#r-name").fill("17歳のテスト");
	await page.locator("#r-birth").fill(underAgeBirthDate());
	await page.getByRole("button", { name: "次へ" }).click();
	// 422 UNDER_AGEでUnderAge表示へ切り替わる(05 §3.2)
	await expect(
		page.getByText("LATCHは、18歳以上の方のためのサービスです。"),
	).toBeVisible();
});
