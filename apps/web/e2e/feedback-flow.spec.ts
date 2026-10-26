/**
 * つながりの品質の自己申告の画面のブラウザE2E(docs/01 §14・docs/05 §3.3・F9)。
 * 成立(matched)まではAPIで進め、成立の時刻をdev専用のbackdate(matched_at)で8日前へずらして、
 * つながり一覧の5段階の問い・お礼・申告後に問いが出ないこと・スキップを画面で確かめる。
 * 地域はweb専用のsite 47(chat-flow.spec.tsの42・43、notices-flow.spec.tsの44〜46と分ける)
 */

import { expect, test } from "@playwright/test";
import { establishLatch, expireLeftoverE2eIntents } from "./helpers";

const NAME_A = "E2Eみなと";
const NAME_B = "E2Eかもめ";

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test.afterEach(() => {
	expireLeftoverE2eIntents();
});

test("成立から7日を過ぎたつながりに5段階の問いが出て、答えると以後は出ない", async ({
	browser,
}) => {
	const { a, b, latchId } = await establishLatch(browser, 47, [NAME_A, NAME_B]);
	const question = (partner: string) =>
		`${partner}さんとのつながりは、どうでしたか。`;

	// 成立直後は問いを出さない
	await a.page.goto("/connections");
	await expect(
		a.page.getByRole("heading", { name: "つながっている" }),
	).toBeVisible();
	await expect(a.page.getByRole("radiogroup", { name: "5段階" })).toHaveCount(
		0,
	);

	const back = await a.page.request.post(
		`/v1/dev/latches/${latchId}/backdate`,
		{
			data: {
				matched_at: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
			},
			headers: { authorization: `Bearer ${a.token}` },
		},
	);
	expect(back.status(), "POST /v1/dev/latches/{id}/backdate").toBe(200);

	// A: 4を選ぶとお礼が出て、問いが消え、開き直しても出ない
	await a.page.reload();
	await expect(a.page.getByText(question(NAME_B))).toBeVisible();
	const sent = a.page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === `/v1/latches/${latchId}/feedback` &&
			r.request().method() === "POST",
	);
	// 入力は見た目のために透明なので、数字の見出し(label)を押す
	await a.page
		.getByRole("radiogroup", { name: "5段階" })
		.locator("label")
		.filter({ hasText: "4" })
		.click();
	expect((await sent).status()).toBe(200);
	await expect(a.page.getByText("ありがとうございます。")).toBeVisible();
	await expect(a.page.getByText(question(NAME_B))).toHaveCount(0);
	await a.page.reload();
	await expect(
		a.page.getByRole("heading", { name: "つながっている" }),
	).toBeVisible();
	await expect(a.page.getByText(question(NAME_B))).toHaveCount(0);

	// B: スキップすると問いが消え、開き直しても出ない(お礼は出さない)
	await b.page.goto("/connections");
	await expect(b.page.getByText(question(NAME_A))).toBeVisible();
	await b.page.getByRole("button", { name: "スキップ" }).click();
	await expect(b.page.getByText(question(NAME_A))).toHaveCount(0);
	await expect(b.page.getByText("ありがとうございます。")).toHaveCount(0);
	await b.page.reload();
	await expect(
		b.page.getByRole("heading", { name: "つながっている" }),
	).toBeVisible();
	await expect(b.page.getByText(question(NAME_A))).toHaveCount(0);
});
