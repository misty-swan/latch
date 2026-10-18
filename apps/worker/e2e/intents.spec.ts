/**
 * Intent APIのE2E(APIレベル・docs/02 §4の#1〜#5・docs/05 §3.2)。
 * Playwrightのrequest fixture(APIRequestContext)のみを使用しブラウザは不要。
 * 入力→確認(parse)→保存(post)→一覧・取得で確認するフローを完走し、
 * stub Parserの抽出規則(docs/07 §3)が決定的なため、#4は期待値との直接照合ができる。
 * 機会のstarts_atは実行時のnow+2時間等を動生成する(E2Eは実時間のため・docs/10 §3)。
 * ローカルD1は実行間で永続するためユーザーはテストごとに登録し(registerUser)、
 * 参加中active数の上限5件(docs/05 §3.1)に収まるよう10件以上の入力セットは
 * ユーザーを5件ずつに分けて保存する
 */

import { type APIRequestContext, expect, test } from "@playwright/test";
import { registerUser } from "./helpers";

/** docs/05 §2.2(geo)の地域添付 */
interface Geo {
	center: { lat: number; lng: number };
	radius_m: number;
}

/** docs/05 §2.2(participants)の参加人数 */
interface Participants {
	min: number;
	max: number;
	includes_owner: boolean;
}

/** docs/05 §2.2(budget)の予算(通貨はJPY固定) */
interface Budget {
	min: number;
	max: number;
	currency: "JPY";
}

/** docs/05 §3.3のparse応答(構造化プレビュー・保存しない) */
interface ParsePreview {
	form: "connection" | "occasion";
	topic: string;
	category: string | null;
	time: { start: string; end: string | null } | null;
	geo: Geo | null;
	participants: Participants;
	budget: Budget | null;
	expires_at_options: string[];
	alcohol_involved: boolean;
	warnings: unknown[];
}

/** docs/05 §3.3のIntentDTO */
interface IntentDTO {
	id: string;
	form: "connection" | "occasion" | null;
	topic: string | null;
	category: string | null;
	raw_text: string;
	time: { start: string; end: string | null } | null;
	geo: Geo | null;
	participants: Participants;
	budget: Budget | null;
	hard_constraints: string[];
	soft_constraints: string[];
	negative_constraints: string[];
	visibility: string;
	notification_level: string;
	alcohol_involved: boolean;
	status: string;
	version: number;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
}

/** docs/05 §3.1の共通エラー応答 */
interface ErrorBody {
	error: { code: string; message: string; details: unknown };
}

/** docs/05 §3.2のGET /v1/intents応答 */
interface ListBody {
	items: IntentDTO[];
	next_cursor: string | null;
}

/** 参加中active数の上限(docs/05 §3.1のACTIVE_INTENT_LIMIT=422) */
const ACTIVE_INTENTS_PER_USER = 5;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** JST=UTC+9の固定オフセット(stub parserと同一方針・docs/07 §3) */
const JST_OFFSET_MS = 9 * MS_PER_HOUR;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** ISO文字列を瞬間(ミリ秒)へ正規化する。プレビューは+09:00表記・DTOはZ表記でも同一瞬間は等しい */
const instant = (iso: string | null | undefined): number | null =>
	iso == null ? null : new Date(iso).getTime();

const authHeaders = (accessToken: string): Record<string, string> => ({
	authorization: `Bearer ${accessToken}`,
});

/** POST /v1/intents/parse(構造化プレビュー・200を保証) */
const parseIntent = async (
	request: APIRequestContext,
	accessToken: string,
	rawText: string,
): Promise<ParsePreview> => {
	const res = await request.post("/v1/intents/parse", {
		data: { raw_text: rawText },
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `POST /v1/intents/parse(${rawText})`).toBe(200);
	return (await res.json()) as ParsePreview;
};

/** POST /v1/intentsのリクエスト(確認画面で確定した内容・docs/05 §3.2) */
interface CreateIntentInput {
	raw_text: string;
	form?: "connection" | "occasion";
	topic?: string;
	time?: { start: string; end: string | null } | null;
	geo?: Geo | null;
	participants?: Participants;
	budget?: Budget | null;
	alcohol_involved?: boolean;
	status?: "draft" | "active";
}

/** POST /v1/intents(保存・既定はactive・201を保証) */
const createIntent = async (
	request: APIRequestContext,
	accessToken: string,
	input: CreateIntentInput,
): Promise<IntentDTO> => {
	const res = await request.post("/v1/intents", {
		data: { status: "active", ...input },
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `POST /v1/intents(${input.raw_text})`).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** PATCH /v1/intents/{id}(部分更新・200を保証) */
const patchIntent = async (
	request: APIRequestContext,
	accessToken: string,
	id: string,
	body: Record<string, unknown>,
): Promise<IntentDTO> => {
	const res = await request.patch(`/v1/intents/${id}`, {
		data: body,
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `PATCH /v1/intents/${id}`).toBe(200);
	return (await res.json()) as IntentDTO;
};

/** GET /v1/intents/{id}(取得・200を保証) */
const getIntent = async (
	request: APIRequestContext,
	accessToken: string,
	id: string,
): Promise<IntentDTO> => {
	const res = await request.get(`/v1/intents/${id}`, {
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `GET /v1/intents/${id}`).toBe(200);
	return (await res.json()) as IntentDTO;
};

/** GET /v1/intents(自Intent一覧・200を保証) */
const listIntents = async (
	request: APIRequestContext,
	accessToken: string,
): Promise<ListBody> => {
	const res = await request.get("/v1/intents?limit=50", {
		headers: authHeaders(accessToken),
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as ListBody;
};

/**
 * プレビュー内容がそのまま保存されていること(docs/02 §4の#1・#2の合格証拠)。
 * 時刻のみ表記ゆえ(+09:00/Z)に文字列比較を避け、瞬間として比較する
 */
const expectSavedMatchesPreview = (
	saved: IntentDTO,
	preview: ParsePreview,
	input: CreateIntentInput,
): void => {
	expect(saved.form).toBe(preview.form);
	expect(saved.topic).toBe(preview.topic);
	expect(saved.category).toBe(preview.category);
	expect(saved.raw_text).toBe(input.raw_text);
	expect(instant(saved.time?.start ?? null)).toBe(
		instant(preview.time?.start ?? null),
	);
	expect(instant(saved.time?.end ?? null)).toBe(
		instant(preview.time?.end ?? null),
	);
	// geoはparseで解決されないため、ユーザーが添付した値がそのまま保存される(05 §3.3)
	expect(saved.geo).toEqual(input.geo ?? null);
	expect(saved.participants).toEqual(preview.participants);
	expect(saved.budget).toEqual(preview.budget);
	expect(saved.alcohol_involved).toBe(preview.alcohol_involved);
	expect(saved.visibility).toBe("hidden_until_match");
	expect(saved.status).toBe("active");
};

/** 比較用にIntentDTOを内容欄へ射影する(id・日時列・versionは除く・時刻は瞬間で比較) */
const comparable = (dto: IntentDTO) => ({
	form: dto.form,
	topic: dto.topic,
	category: dto.category,
	raw_text: dto.raw_text,
	time:
		dto.time === null
			? null
			: { start: instant(dto.time.start), end: instant(dto.time.end) },
	geo: dto.geo,
	participants: dto.participants,
	budget: dto.budget,
	hard_constraints: dto.hard_constraints,
	soft_constraints: dto.soft_constraints,
	negative_constraints: dto.negative_constraints,
	visibility: dto.visibility,
	notification_level: dto.notification_level,
	alcohol_involved: dto.alcohol_involved,
	status: dto.status,
	expires_at: instant(dto.expires_at),
});

/**
 * stubの規則(docs/07 §3): 時刻語は「パース実行時刻のJST翌日のその時刻」と解釈される。
 * #4の期待値をこの形で組み立てる
 */
const expectedOccasionStart = (hour: number, half = false): string => {
	const shifted = new Date(Date.now() + JST_OFFSET_MS);
	shifted.setUTCDate(shifted.getUTCDate() + 1);
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(hour)}:${half ? "30" : "00"}:00+09:00`;
};

/**
 * 機会Intentのstarts_atを実行時のnow+2時間として動生成する
 * (E2Eは実時間のため時計を操作せずseedで制御・docs/10 §3)。Z形式でも可
 */
const startsAtTwoHoursLater = (): string =>
	new Date(Date.now() + 2 * MS_PER_HOUR).toISOString();

test("#1 つながりIntent: 入力→確認→保存を12件で完走する(主題のみ/主題+地域/主題+人数)", async ({
	request,
}) => {
	const cases: { label: string; raw_text: string; geo?: Geo }[] = [
		{ label: "主題のみ", raw_text: "個人開発仲間が欲しい" },
		{ label: "主題のみ", raw_text: "ランニング仲間を探しています" },
		{ label: "主題のみ", raw_text: "ボードゲーム好き集まれ" },
		{ label: "主題のみ", raw_text: "英語で話す相手が欲しいです" },
		{
			label: "主題+地域",
			raw_text: "渋谷周辺でランチ仲間募集",
			geo: { center: { lat: 35.6595, lng: 139.7005 }, radius_m: 1000 },
		},
		{
			label: "主題+地域",
			raw_text: "新宿でカフェ会したい",
			geo: { center: { lat: 35.6938, lng: 139.7034 }, radius_m: 2000 },
		},
		{
			label: "主題+地域",
			raw_text: "横浜で読書会やりませんか",
			geo: { center: { lat: 35.4437, lng: 139.638 }, radius_m: 3000 },
		},
		{ label: "主題+人数", raw_text: "3人でテニスしませんか" },
		{ label: "主題+人数", raw_text: "2〜4人でバスケやりたい" },
		{ label: "主題+人数", raw_text: "4人でエスケープルームに行きたい" },
		{ label: "主題のみ", raw_text: "初心者向けの写真会に参加したい" },
		{ label: "主題のみ", raw_text: "週末にハイキング仲間募集" },
	];

	// 参加中active数の上限(5件)に収まるよう、5件ずつユーザーを変えて保存する
	for (
		let offset = 0;
		offset < cases.length;
		offset += ACTIVE_INTENTS_PER_USER
	) {
		const chunk = cases.slice(offset, offset + ACTIVE_INTENTS_PER_USER);
		const { access_token } = await registerUser(
			request,
			`E2Eつながり${offset}`,
		);
		const savedList: IntentDTO[] = [];
		for (const c of chunk) {
			// 入力→確認: stubは時刻語・日付語のない表現をconnectionと判定する(07 §3)
			const preview = await parseIntent(request, access_token, c.raw_text);
			expect(preview.form, `${c.label}: ${c.raw_text}`).toBe("connection");
			expect(preview.time, c.raw_text).toBeNull();
			// 保存: プレビュー内容+地域添付(ユーザーが確定させる・05 §3.3)でactive保存
			const saved = await createIntent(request, access_token, {
				raw_text: c.raw_text,
				form: preview.form,
				topic: preview.topic,
				participants: preview.participants,
				budget: preview.budget,
				geo: c.geo ?? null,
				alcohol_involved: preview.alcohol_involved,
			});
			expectSavedMatchesPreview(saved, preview, c);
			// つながりの既定期限はactive化時刻+30日(±1時間の許容・05 §2.2)
			expect(instant(saved.expires_at)).toBeGreaterThan(
				Date.now() + 30 * MS_PER_DAY - MS_PER_HOUR,
			);
			expect(instant(saved.expires_at)).toBeLessThan(
				Date.now() + 30 * MS_PER_DAY + MS_PER_HOUR,
			);
			savedList.push(saved);
		}
		// 合格証拠: 保存済みIntentが一覧表示され、プレビュー内容が保存されている
		const listed = await listIntents(request, access_token);
		expect(listed.items).toHaveLength(chunk.length);
		expect(listed.next_cursor).toBeNull();
		for (const saved of savedList) {
			const fetched = await getIntent(request, access_token, saved.id);
			expect(fetched).toEqual(saved);
			expect(listed.items).toContainEqual(fetched);
		}
	}
});

test("#2 機会Intent: 入力→確認→保存を12件で完走する(時刻・場所つき・下書き経路を含む)", async ({
	request,
}) => {
	const cases: { raw_text: string; geo: Geo }[] = [
		{
			raw_text: "銀座で19時からワイン会",
			geo: { center: { lat: 35.6712, lng: 139.7671 }, radius_m: 1000 },
		},
		{
			raw_text: "渋谷で20時半に飲み会",
			geo: { center: { lat: 35.6595, lng: 139.7005 }, radius_m: 1000 },
		},
		{
			raw_text: "新宿で12時にランチ会",
			geo: { center: { lat: 35.6938, lng: 139.7034 }, radius_m: 2000 },
		},
		{
			raw_text: "横浜で15時にボードゲーム会",
			geo: { center: { lat: 35.4437, lng: 139.638 }, radius_m: 3000 },
		},
		{
			raw_text: "池袋で18時から映画を見る会",
			geo: { center: { lat: 35.7295, lng: 139.7109 }, radius_m: 1500 },
		},
		{
			raw_text: "京都で9時に朝ラン集合",
			geo: { center: { lat: 35.0116, lng: 135.7681 }, radius_m: 5000 },
		},
		{
			raw_text: "神戸で14時半からカフェ巡り",
			geo: { center: { lat: 34.6901, lng: 135.1955 }, radius_m: 2000 },
		},
		{
			raw_text: "札幌で11時にジムで運動",
			geo: { center: { lat: 43.0687, lng: 141.3508 }, radius_m: 5000 },
		},
		{
			raw_text: "福岡で21時から晩ごはん会",
			geo: { center: { lat: 33.5904, lng: 130.4017 }, radius_m: 3000 },
		},
		{
			raw_text: "名古屋で13時に写真撮影会",
			geo: { center: { lat: 35.1815, lng: 136.9066 }, radius_m: 4000 },
		},
		{
			raw_text: "千葉で17時に夕食会",
			geo: { center: { lat: 35.6073, lng: 140.1064 }, radius_m: 3000 },
		},
		{
			raw_text: "広島で16時半から木工教室",
			geo: { center: { lat: 34.3853, lng: 132.4553 }, radius_m: 4000 },
		},
	];

	// Part 1: プレビュー→そのままactive保存(12件すべて)
	const directCases = cases;
	const savedByRawText = new Map<string, IntentDTO>();
	for (
		let offset = 0;
		offset < directCases.length;
		offset += ACTIVE_INTENTS_PER_USER
	) {
		const chunk = directCases.slice(offset, offset + ACTIVE_INTENTS_PER_USER);
		const { access_token } = await registerUser(request, `E2E機会${offset}`);
		const savedList: IntentDTO[] = [];
		for (const c of chunk) {
			// 入力→確認: 時刻語のある表現は機会(時刻確定)と判定される(07 §3)
			const preview = await parseIntent(request, access_token, c.raw_text);
			expect(preview.form, c.raw_text).toBe("occasion");
			expect(preview.time, c.raw_text).not.toBeNull();
			// 保存: プレビューの時刻+ユーザーが添付した地域でactive保存
			const saved = await createIntent(request, access_token, {
				raw_text: c.raw_text,
				form: preview.form,
				topic: preview.topic,
				time: preview.time,
				participants: preview.participants,
				budget: preview.budget,
				geo: c.geo,
				alcohol_involved: preview.alcohol_involved,
			});
			expectSavedMatchesPreview(saved, preview, c);
			// 機会の既定期限はstart+3時間(docs/05 §2.2)
			expect(instant(saved.expires_at)).toBe(
				(instant(saved.time?.start ?? null) ?? 0) + 3 * MS_PER_HOUR,
			);
			savedList.push(saved);
			savedByRawText.set(c.raw_text, saved);
		}
		// 合格証拠: 保存済みIntentが一覧表示され、プレビュー内容が保存されている
		const listed = await listIntents(request, access_token);
		expect(listed.items).toHaveLength(chunk.length);
		for (const saved of savedList) {
			expect(await getIntent(request, access_token, saved.id)).toEqual(saved);
			expect(listed.items).toContainEqual(saved);
		}
	}

	// Part 2: 下書き保存→再開→編集→預けるの経路(draft→active・1件以上)
	// 同一入力を直接保存したIntentと比較し、下書き経路でも同一結果となることを示す
	const draftCase = cases[0];
	const { access_token: draftToken } = await registerUser(
		request,
		"E2E機会下書き経路",
	);
	const preview = await parseIntent(request, draftToken, draftCase.raw_text);
	expect(preview.form).toBe("occasion");
	expect(preview.time).not.toBeNull();
	// draft保存: 意味検証せず・期限は確定しない(選択は預ける時に確定・05 §3.2)
	const draft = await createIntent(request, draftToken, {
		raw_text: draftCase.raw_text,
		form: preview.form,
		topic: preview.topic,
		time: preview.time,
		participants: preview.participants,
		budget: preview.budget,
		geo: draftCase.geo,
		alcohol_involved: preview.alcohol_involved,
		status: "draft",
	});
	expect(draft.status).toBe("draft");
	expect(draft.version).toBe(1);
	expect(draft.expires_at).toBeNull();
	// 再開: GETで下書きの保存内容を確認する
	expect(await getIntent(request, draftToken, draft.id)).toEqual(draft);
	// 編集: draftは全項目可変(05 §3.2)。地域の半径を修正する
	const editedGeo = { ...draftCase.geo, radius_m: 5000 };
	const patched = await patchIntent(request, draftToken, draft.id, {
		geo: editedGeo,
	});
	expect(patched.status).toBe("draft");
	expect(patched.version).toBe(2);
	expect(patched.geo).toEqual(editedGeo);
	// 預ける: status=activeでactive化(マージ結果の意味検証→期限確定・05 §3.2)
	const activated = await patchIntent(request, draftToken, draft.id, {
		status: "active",
	});
	expect(activated.status).toBe("active");
	expect(activated.version).toBe(3);
	// 下書き経路でも同一結果(直接保存との差は編集したgeoのみ)
	const direct = savedByRawText.get(draftCase.raw_text);
	if (direct === undefined) {
		throw new Error("比較元の直接保存Intentが見つかりません");
	}
	expect(comparable(activated)).toEqual({
		...comparable(direct),
		geo: editedGeo,
	});
	// 一覧にも表示される
	const listed = await listIntents(request, draftToken);
	expect(listed.items).toHaveLength(1);
	expect(listed.items[0]).toEqual(activated);
});

test("#3 formの確認・切替: プレビューのformを確認し、切替後のformで保存される", async ({
	request,
}) => {
	// つながりと読める表現(stubはconnection)→機会へ切替えて保存
	{
		const { access_token } = await registerUser(request, "E2Eform切替つながり");
		for (const raw of ["個人開発仲間が欲しい", "ボードゲーム好き集まれ"]) {
			const preview = await parseIntent(request, access_token, raw);
			expect(preview.form, raw).toBe("connection");
			// 機会にはstarts_atが必須のため、切替時に実行時動生成の時刻を添える
			const start = startsAtTwoHoursLater();
			const saved = await createIntent(request, access_token, {
				raw_text: raw,
				form: "occasion",
				topic: preview.topic,
				time: { start, end: null },
				participants: preview.participants,
			});
			expect(saved.form).toBe("occasion");
			expect(instant(saved.time?.start ?? null)).toBe(instant(start));
		}
	}
	// 機会と読める表現(stubはoccasion)→つながりへ切替えて保存
	{
		const { access_token } = await registerUser(request, "E2Eform切替機会");
		for (const raw of ["日曜10時に近所でランチ会", "19時に映画上映会"]) {
			const preview = await parseIntent(request, access_token, raw);
			expect(preview.form, raw).toBe("occasion");
			// つながりはstarts_at不可のため、切替時に時刻を外す(05 §2.2)
			const saved = await createIntent(request, access_token, {
				raw_text: raw,
				form: "connection",
				topic: preview.topic,
				time: null,
				participants: preview.participants,
			});
			expect(saved.form).toBe("connection");
			expect(saved.time).toBeNull();
		}
	}
	// 曖昧表現: stubは安全側のconnectionを返す(07 §3)・starts_atを添えて機会として保存
	{
		const { access_token } = await registerUser(request, "E2Eform切替曖昧");
		const raw = "今度飲みに行く仲間が欲しい";
		const preview = await parseIntent(request, access_token, raw);
		expect(preview.form, raw).toBe("connection");
		const start = startsAtTwoHoursLater();
		const saved = await createIntent(request, access_token, {
			raw_text: raw,
			form: "occasion",
			topic: preview.topic,
			time: { start, end: null },
			participants: preview.participants,
			// 「飲み」で飲酒ありと判定される(07 §3の辞書)。機会なら保存できる
			alcohol_involved: preview.alcohol_involved,
		});
		expect(saved.form).toBe("occasion");
		expect(saved.alcohol_involved).toBe(true);
	}
});

test("#4 構造化: 入力セット各件のtopic・time・participants・budgetを期待値と照合する", async ({
	request,
}) => {
	const { access_token } = await registerUser(request, "E2E構造化照合");
	const cases: {
		raw_text: string;
		form: "connection" | "occasion";
		// hourがundefined=時刻語なし(time null)・指定時はJST翌日のその時刻
		hour?: number;
		half?: boolean;
		topic: string;
		participants: { min: number; max: number };
		budget: { min: number; max: number } | null;
		alcohol: boolean;
	}[] = [
		{
			raw_text: "個人開発の朝会に興味がある",
			form: "connection",
			topic: "個人開発の朝会に興味がある",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			raw_text: "5000円くらいでランチ仲間募集",
			form: "connection",
			topic: "5000円くらいでランチ仲間募集",
			participants: { min: 2, max: 2 },
			budget: { min: 5000, max: 5000 },
			alcohol: false,
		},
		{
			raw_text: "3000円で映画を見に行く仲間",
			form: "connection",
			topic: "3000円で映画を見に行く仲間",
			participants: { min: 2, max: 2 },
			budget: { min: 3000, max: 3000 },
			alcohol: false,
		},
		{
			raw_text: "123456円の高級ディナー会",
			form: "connection",
			topic: "123456円の高級ディナー会",
			participants: { min: 2, max: 2 },
			budget: { min: 123456, max: 123456 },
			alcohol: false,
		},
		{
			raw_text: "2〜4人でボードゲーム会",
			form: "connection",
			topic: "2〜4人でボードゲーム会",
			participants: { min: 2, max: 4 },
			budget: null,
			alcohol: false,
		},
		{
			raw_text: "3人でテニス練習",
			form: "connection",
			topic: "3人でテニス練習",
			participants: { min: 3, max: 3 },
			budget: null,
			alcohol: false,
		},
		{
			raw_text: "7000円くらい 2人でビリヤード",
			form: "connection",
			topic: "7000円くらい 2人でビリヤード",
			participants: { min: 2, max: 2 },
			budget: { min: 7000, max: 7000 },
			alcohol: false,
		},
		{
			raw_text: "19時半に銀座で飲み会 5000円くらい 2〜4人",
			form: "occasion",
			hour: 19,
			half: true,
			topic: "19時半に銀座で飲み会 5000円くらい 2〜4人",
			participants: { min: 2, max: 4 },
			budget: { min: 5000, max: 5000 },
			alcohol: true,
		},
		{
			// 日付語のみ: 機会だが時刻は確定しない(07 §3)
			raw_text: "明日ランチしよう",
			form: "occasion",
			topic: "明日ランチしよう",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			raw_text: "10時に渋谷で朝ラン",
			form: "occasion",
			hour: 10,
			topic: "10時に渋谷で朝ラン",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			// topicは最初の句点まで(07 §3)
			raw_text: "カレー会をします。的心理テストもします",
			form: "connection",
			topic: "カレー会をします",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			// topicは最初の改行まで(07 §3)
			raw_text: "ボードゲーム会\n詳しくはDMで",
			form: "connection",
			topic: "ボードゲーム会",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			// topicは40字で切り詰める(07 §3・04 §5)
			raw_text: "あ".repeat(50),
			form: "connection",
			topic: "あ".repeat(40),
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: false,
		},
		{
			// 飲酒辞書は部分一致(「バー」)でrecall優先(07 §3)
			raw_text: "公園でバーベキュー",
			form: "connection",
			topic: "公園でバーベキュー",
			participants: { min: 2, max: 2 },
			budget: null,
			alcohol: true,
		},
	];

	// フィールドごとの一致/不一致一覧(02 §4の#4合格証拠): 不一致は全件ここで表面化する
	const mismatches: string[] = [];
	for (const [index, c] of cases.entries()) {
		const preview = await parseIntent(request, access_token, c.raw_text);
		const expectedTime =
			c.hour === undefined
				? null
				: {
						start: expectedOccasionStart(c.hour, c.half ?? false),
						end: null,
					};
		const checks: [string, unknown, unknown][] = [
			["form", preview.form, c.form],
			["topic", preview.topic, c.topic],
			[
				"time",
				preview.time === null
					? null
					: {
							start: instant(preview.time.start),
							end: instant(preview.time.end),
						},
				expectedTime === null
					? null
					: {
							start: instant(expectedTime.start),
							end: instant(expectedTime.end),
						},
			],
			// parseは地域を解決しない(ユーザーが添付で確定させる・05 §3.3)
			["location(geo)", preview.geo, null],
			[
				"participants",
				{
					min: preview.participants.min,
					max: preview.participants.max,
					includes_owner: preview.participants.includes_owner,
				},
				{
					min: c.participants.min,
					max: c.participants.max,
					includes_owner: true,
				},
			],
			[
				"budget",
				preview.budget === null
					? null
					: { min: preview.budget.min, max: preview.budget.max },
				c.budget,
			],
			["alcohol_involved(補助)", preview.alcohol_involved, c.alcohol],
		];
		for (const [field, actual, expected] of checks) {
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				mismatches.push(
					`入力セット${index + 1}「${c.raw_text}」の${field}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
				);
			}
		}
	}
	expect(mismatches).toEqual([]);
});

test("#5 解析内容の修正: プレビューのtopic・participants・budgetを変更して保存できる", async ({
	request,
}) => {
	const { access_token } = await registerUser(request, "E2E修正保存");
	// つながり: プレビューを確認してから3欄を修正する
	{
		const raw = "2〜4人でボードゲーム 3000円くらい";
		const preview = await parseIntent(request, access_token, raw);
		expect(preview.topic).toBe(raw);
		expect(preview.participants).toEqual({
			min: 2,
			max: 4,
			includes_owner: true,
		});
		expect(preview.budget).toEqual({ min: 3000, max: 3000, currency: "JPY" });
		const saved = await createIntent(request, access_token, {
			raw_text: raw,
			form: preview.form,
			topic: "初級歓迎のボードゲーム会",
			participants: { min: 3, max: 4, includes_owner: true },
			budget: { min: 4000, max: 5000, currency: "JPY" },
		});
		// 修正値がそのまま保存されている(02 §4の#5合格証拠)
		expect(saved.topic).toBe("初級歓迎のボードゲーム会");
		expect(saved.participants).toEqual({
			min: 3,
			max: 4,
			includes_owner: true,
		});
		expect(saved.budget).toEqual({ min: 4000, max: 5000, currency: "JPY" });
		expect(await getIntent(request, access_token, saved.id)).toEqual(saved);
	}
	// 機会: 同様に修正して保存する
	{
		const raw = "19時に銀座で飲み会 5000円くらい";
		const preview = await parseIntent(request, access_token, raw);
		expect(preview.form).toBe("occasion");
		expect(preview.time).not.toBeNull();
		const saved = await createIntent(request, access_token, {
			raw_text: raw,
			form: preview.form,
			topic: "銀座で静かに飲み会",
			time: preview.time,
			participants: { min: 3, max: 3, includes_owner: true },
			budget: { min: 6000, max: 6000, currency: "JPY" },
			geo: { center: { lat: 35.6712, lng: 139.7671 }, radius_m: 1500 },
		});
		expect(saved.topic).toBe("銀座で静かに飲み会");
		expect(saved.participants).toEqual({
			min: 3,
			max: 3,
			includes_owner: true,
		});
		expect(saved.budget).toEqual({ min: 6000, max: 6000, currency: "JPY" });
	}
});

test("補助: 他人のIntentはGETで404(存在を露見させない・05 §3.1)", async ({
	request,
}) => {
	const owner = await registerUser(request, "E2E所有者");
	const raw = "個人開発仲間が欲しい";
	const preview = await parseIntent(request, owner.access_token, raw);
	const saved = await createIntent(request, owner.access_token, {
		raw_text: raw,
		form: preview.form,
		topic: preview.topic,
	});
	const other = await registerUser(request, "E2E他人");
	const res = await request.get(`/v1/intents/${saved.id}`, {
		headers: authHeaders(other.access_token),
	});
	expect(res.status()).toBe(404);
	const body = (await res.json()) as ErrorBody;
	expect(body.error.code).toBe("NOT_FOUND");
});
