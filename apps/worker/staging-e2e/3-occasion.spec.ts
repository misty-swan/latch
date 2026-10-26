/**
 * stagingの通し試験(3): 機会Intentの主な流れ(docs/10 §4・02 #2・#9・#16)。
 * 同じ日時・同じ地域で、言い方の違う2つの機会Intentを本物のParserで読み解いて預け、
 * 提案・提案のアプリ内通知・成立前に中身を出さないこと(#20)・双方の[参加する]での成立・
 * 成立の通知・成立後の提案の時間帯と地域の表し方(#29)を確かめる。
 * Dの意思がVectorizeへ反映したのを確かめてからEが預ける(負荷試験の(b)と同じ2段)。
 * 時刻は本物のParserが文の「明日の21時」から読む(stubは翌日の21時)。読み解いた時刻が
 * 2人で食い違うと時間の重なりの条件(Layer 1)で外れるため、手がかりに読み解きの結果を出す。
 * 本物のAIの呼び出しの目安: Parser 2回・Embedding 2回・Jev 1〜2回
 */

import type { LatchDTO } from "@latch/shared";
import { expect, test } from "@playwright/test";
import {
	bearer,
	flowBody,
	parse,
	registerUser,
	respond,
	type SavedIntent,
	type StagingUser,
	saveIntent,
	waitForEvaluated,
	waitForNotification,
	waitForPairLatch,
	waitForReflection,
} from "./lib";

const TEXT_D = "明日の21時から恵比寿でボードゲームをしませんか";
const TEXT_E = "明日21時ごろ恵比寿で、ボドゲを一緒に遊べる人を募集しています";

test.setTimeout(30 * 60_000);

test("機会: 同じ日時と地域の言い方の違う意思が提案され、参加すると成立する", async ({
	request,
}) => {
	const save = async (user: StagingUser, text: string): Promise<SavedIntent> =>
		saveIntent(
			request,
			user,
			flowBody(await parse(request, user, text), text, "occasion"),
		);
	const d = await registerUser(request, "d", "通し試験D");
	const e = await registerUser(request, "e", "通し試験E");

	const p = await save(d, TEXT_D);
	expect(p.form).toBe("occasion");
	await waitForReflection(request, d, p.id, "Dの意思");
	const q = await save(e, TEXT_E);
	await waitForEvaluated(request, e, q.id, "Eの意思");
	const latch = await waitForPairLatch(request, e, q.id, [p.id], "DとEの提案");
	expect(latch.form).toBe("occasion");

	await waitForNotification(request, d, "proposal", latch.id, "D");
	await waitForNotification(request, e, "proposal", latch.id, "E");
	const view = async (): Promise<{ text: string; dto: LatchDTO }> => {
		const res = await request.get(`/v1/latches/${latch.id}`, {
			headers: bearer(d.access_token),
		});
		expect(res.status(), "GET /v1/latches/{id}").toBe(200);
		const text = await res.text();
		return { text, dto: JSON.parse(text) as LatchDTO };
	};
	// 成立前は提案の中身と相手を出さない(#20・hidden_until_match)
	const before = await view();
	expect(before.dto.status).toBe("proposed");
	expect(before.dto).not.toHaveProperty("proposal");
	expect(before.dto).not.toHaveProperty("members");

	await respond(request, d, latch.id, "yes");
	expect((await respond(request, e, latch.id, "yes")).status).toBe("matched");
	await waitForNotification(request, d, "matched", latch.id, "D");
	await waitForNotification(request, e, "matched", latch.id, "E");

	// 成立後の中身: 機会の時間帯があり、地域は地域名(または無し)で緯度経度を出さない(#29)
	const after = await view();
	expect(after.dto.proposal?.form).toBe("occasion");
	expect(after.dto.proposal?.time_window).not.toBeNull();
	expect(after.text).not.toMatch(/"(lat|lng|radius_m|distance)"/);
});
