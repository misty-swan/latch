/**
 * stagingの通し試験(1): 意思の登録とformの確認(02 #1〜#4を本物のParserで補う・docs/10 §4)。
 * 1人の利用者で、つながりIntent(主題のみ/主題+地域/主題+人数)・機会Intent(時刻と場所と予算・
 * 下書き→再開→預ける)・曖昧な文のformの選び直しを、読み解き→保存→取得で流す。
 * 本物のParserの出力は揺れるため、主題や時刻の文字列の完全一致は見ず、formと必須の欄・
 * 時刻が近い未来にあること・人数と予算の幅に文中の数が入ることを確かめる(stubでも同じ断言が通る)。
 * 自分の意思どうしは提案されない(Layer 1の自己ペア)。保存した意思は確かめたらすぐ消し、
 * 他の試験の候補検索を汚さない。本物のAIの呼び出しはParser 6回・Embedding 6回
 */

import { expect, test } from "@playwright/test";
import {
	bearer,
	deleteIntent,
	type ParsePreview,
	parse,
	registerUser,
	type SavedIntent,
	SITE,
	type StagingUser,
	saveIntent,
} from "./lib";

const HOUR_MS = 3_600_000;

/** 読み解き確認の[預ける]と同じ組み立て(読み解いた値をそのまま使う・地域は利用者が添える) */
const confirmBody = (
	preview: ParsePreview,
	rawText: string,
	geo: typeof SITE | null,
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		raw_text: rawText,
		form: preview.form,
		topic: preview.topic.trim().slice(0, 40),
		category: preview.category,
		time: preview.time,
		geo,
		participants: { ...preview.participants, includes_owner: true },
		budget:
			preview.budget === null ? null : { ...preview.budget, currency: "JPY" },
		alcohol_involved: preview.alcohol_involved,
		status: "active",
	};
	if (preview.form === "occasion" && preview.time !== null) {
		body.expires_at = new Date(
			new Date(preview.time.start).getTime() + 3 * HOUR_MS,
		).toISOString();
	} else {
		body.expires_in_days = 30;
	}
	return body;
};

const getIntent = async (
	request: Parameters<typeof deleteIntent>[0],
	user: StagingUser,
	id: string,
): Promise<SavedIntent & { geo: unknown }> => {
	const res = await request.get(`/v1/intents/${id}`, {
		headers: bearer(user.access_token),
	});
	expect(res.status(), "GET /v1/intents/{id}").toBe(200);
	return (await res.json()) as SavedIntent & { geo: unknown };
};

/** 機会の時刻が近い未来(今から3日以内)にあること。文の「明日」「明後日」を読めている */
const expectNearFuture = (start: string, rawText: string): void => {
	const ms = new Date(start).getTime();
	expect(Number.isNaN(ms), `時刻の形式(${rawText})`).toBe(false);
	expect(ms, `時刻が未来(${rawText})`).toBeGreaterThan(Date.now());
	expect(ms, `時刻が3日以内(${rawText})`).toBeLessThanOrEqual(
		Date.now() + 72 * HOUR_MS,
	);
};

test.setTimeout(10 * 60_000);

test("登録: つながりIntentと機会Intentを本物のParserで読み解いて保存し、formを選び直せる", async ({
	request,
}) => {
	const user = await registerUser(request, "reg", "通し試験の登録");

	/** 保存して取り出し、読み解き確認の内容が保存されていることを確かめてから消す */
	const saveAndCheck = async (
		body: Record<string, unknown>,
	): Promise<SavedIntent> => {
		const saved = await saveIntent(request, user, body);
		const got = await getIntent(request, user, saved.id);
		expect(got.status).toBe("active");
		expect(got.form).toBe(body.form);
		expect(got.topic).toBe(body.topic);
		expect(got.raw_text).toBe(body.raw_text);
		expect(got.geo).toEqual(body.geo);
		expect(got.participants.min).toBe(
			(body.participants as { min: number }).min,
		);
		const list = await request.get("/v1/intents?limit=50", {
			headers: bearer(user.access_token),
		});
		expect(list.status(), "GET /v1/intents").toBe(200);
		const { items } = (await list.json()) as { items: { id: string }[] };
		expect(items.map((i) => i.id)).toContain(saved.id);
		await deleteIntent(request, user, saved.id);
		return got;
	};

	await test.step("#1 つながりIntent(主題のみ/主題+地域/主題+人数)", async () => {
		const cases = [
			{ text: "ランニング仲間を探しています", geo: null },
			{ text: "横浜で読書会の仲間が欲しい", geo: SITE },
			{ text: "3人でボードゲームを楽しめる仲間を探しています", geo: null },
		];
		for (const c of cases) {
			const preview = await parse(request, user, c.text);
			// #3・#4: つながりと読める文はconnection・時刻なし・主題が埋まる
			expect(preview.form, `form(${c.text})`).toBe("connection");
			expect(preview.time, `時刻なし(${c.text})`).toBeNull();
			expect(preview.topic.trim().length, `主題(${c.text})`).toBeGreaterThan(0);
			if (c.text.startsWith("3人")) {
				// #4: 人数の幅に文中の3人が入る(本人を含めるかの読みの揺れは問わない)
				expect(preview.participants.max, "人数の上限").toBeGreaterThanOrEqual(
					3,
				);
			}
			await saveAndCheck(confirmBody(preview, c.text, c.geo));
		}
	});

	await test.step("#2 機会Intent(時刻・場所・予算つき)", async () => {
		const text = "明日の19時から渋谷でボードゲーム会、予算は3000円くらい";
		const preview = await parse(request, user, text);
		expect(preview.form, `form(${text})`).toBe("occasion");
		expect(preview.time, `時刻(${text})`).not.toBeNull();
		expectNearFuture(preview.time?.start ?? "", text);
		// #4: 予算の幅に文中の3000円が入る
		expect(preview.budget, `予算(${text})`).not.toBeNull();
		expect(preview.budget?.min ?? Number.NaN).toBeLessThanOrEqual(3000);
		expect(preview.budget?.max ?? Number.NaN).toBeGreaterThanOrEqual(3000);
		const saved = await saveAndCheck(confirmBody(preview, text, SITE));
		expect(saved.time).not.toBeNull();
	});

	await test.step("#2 機会Intent(下書き保存→再開→預ける)", async () => {
		const text = "明後日の20時に新宿で飲み会をしませんか";
		const preview = await parse(request, user, text);
		expect(preview.form, `form(${text})`).toBe("occasion");
		expectNearFuture(preview.time?.start ?? "", text);
		// #4: 飲酒を含むと読める(20歳以上の利用者のため保存できる・#30)
		expect(preview.alcohol_involved, `飲酒(${text})`).toBe(true);
		const body = confirmBody(preview, text, SITE);
		const { expires_at: _, ...draftBody } = body;
		const draft = await saveIntent(request, user, {
			...draftBody,
			status: "draft",
		});
		expect(draft.status).toBe("draft");
		// 再開: 下書きの内容が残っている
		const resumed = await getIntent(request, user, draft.id);
		expect(resumed.status).toBe("draft");
		expect(resumed.topic).toBe(body.topic);
		// 預ける: active化(期限はここで確定する・05 §3.2)
		const res = await request.patch(`/v1/intents/${draft.id}`, {
			data: { status: "active" },
			headers: bearer(user.access_token),
		});
		expect(res.status(), "PATCH /v1/intents/{id}(status=active)").toBe(200);
		const activated = await getIntent(request, user, draft.id);
		expect(activated.status).toBe("active");
		expect(activated.form).toBe("occasion");
		expect(activated.topic).toBe(body.topic);
		expect(activated.alcohol_involved).toBe(true);
		await deleteIntent(request, user, draft.id);
	});

	await test.step("#3 曖昧な文はformを選び直して保存できる", async () => {
		const text = "今度飲みに行く仲間が欲しい";
		const preview = await parse(request, user, text);
		// 曖昧な文のformはどちらでもよい(読みの揺れを許す)。利用者が反対のformへ選び直す
		const switched = preview.form === "connection" ? "occasion" : "connection";
		const body = confirmBody(preview, text, SITE);
		body.form = switched;
		if (switched === "occasion") {
			// 機会へ選び直すと日時の入力が要る(読み解き確認で利用者が入れる)
			const start = new Date(Date.now() + 26 * HOUR_MS);
			body.time = { start: start.toISOString(), end: null };
			body.expires_at = new Date(start.getTime() + 3 * HOUR_MS).toISOString();
			delete body.expires_in_days;
		} else {
			body.time = null;
			body.budget = null;
			body.alcohol_involved = false;
			body.expires_in_days = 30;
			delete body.expires_at;
		}
		const saved = await saveAndCheck(body);
		expect(saved.form, "選び直したformで保存される").toBe(switched);
	});
});
