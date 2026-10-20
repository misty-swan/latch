/**
 * マッチングパイプラインのE2E(APIレベル・docs/02 §4の#6〜#11・#13)。
 * Playwrightのrequest fixture(APIRequestContext)のみを使用しブラウザは不要。
 * Intent APIで実際にデータを投入し、Task 13のdev観測API
 * (GET /v1/dev/match-events・GET /v1/dev/match-candidates)でパイプラインの
 * 生成記録を観測する。Cronはwrangler dev --test-scheduledのGET /__scheduled
 * (helpers.tsのrunCron)で強制発火する。
 *
 * 待ち方の規律(docs/10 §3の実時間): 各ケースはIntent作成後、起点Intentの
 * embedding_completedイベントがprocessedになるまでwaitForで待ってから観測する
 * (payloadに第2段の計測結果が載る・docs/06 §7)。作成は1件ずつ直前の評価の
 * 完了を待って行うことで、各評価時点の検索取り出し幅を決定的にする。
 * stubベクトル(docs/07 §2)は語の意味を持たないため、候補化の成否は
 * 「検索の取り出し幅(topK=100)が少数コーパスの当該ペアを確実に含む」ことに
 * よる(10 §3のseed方針)。実Embeddingでの意味近接の質はreal適用時の
 * 精度ゲート(07 §6)で検証する。
 *
 * 後片付け: 各ケースの最後で作成したIntentをDELETEする(docs/05 §2.5により
 * 候補・イベント・ベクトルも一緒に消える)。ローカルD1は実行間で永続し、
 * wrangler devのプロセス内ではインメモリのベクトルストアが全specで共有される
 * ため、これ以降のケースの観測を自分のケース内のデータだけに限定するためである
 */

import { EXPIRY_CHOICES_DAYS, PIPELINE } from "@latch/shared";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { registerUser, runCron, waitFor } from "./helpers";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** docs/05 §2.2(geo)の地域添付 */
interface Geo {
	center: { lat: number; lng: number };
	radius_m: number;
}

/** パイプラインE2Eで使うIntentDTOの必要欄(docs/05 §3.3) */
interface IntentDTO {
	id: string;
	form: "connection" | "occasion" | null;
	topic: string | null;
	status: string;
	version: number;
	expires_at: string | null;
}

/** GET /v1/dev/match-eventsの1項目(docs/05 §3.1・Task 13の観測契約) */
interface MatchEventItem {
	id: string;
	event_type: string;
	source_intent_id: string;
	version: number;
	status: string;
	payload: unknown;
	created_at: string;
	processed_at: string | null;
}

/** GET /v1/dev/match-candidatesの1項目(同上) */
interface MatchCandidateItem {
	id: string;
	intent_a_id: string;
	intent_b_id: string;
	intent_a_version: number;
	intent_b_version: number;
	form: string;
	retrieval_score: number | null;
	cheap_judge_score: number | null;
	status: string;
	created_at: string;
	updated_at: string;
}

/** 一覧応答の共通形({items, next_cursor}・docs/05 §3.1) */
interface PageBody<T> {
	items: T[];
	next_cursor: string | null;
}

/**
 * embedding_completedイベントのpayloadに載る第2段の計測結果
 * (docs/06 §7・consumer.tsが記録する)。抑制時は代わりに{skipped}が載る
 */
interface Stage2Payload {
	retrieval_count: number;
	l1_pass: number;
	l1_exclusions: Record<string, number>;
	l3_pass: number;
}

/** payloadが第2段の計測結果か(抑制{skipped}との判別) */
const isStage2Payload = (payload: unknown): payload is Stage2Payload =>
	typeof payload === "object" &&
	payload !== null &&
	typeof (payload as Stage2Payload).retrieval_count === "number";

/** Bearer認証ヘッダー */
const authHeaders = (accessToken: string): Record<string, string> => ({
	authorization: `Bearer ${accessToken}`,
});

/** つながりIntentを作成する(status=active・201を保証) */
const createConnection = async (
	request: APIRequestContext,
	accessToken: string,
	input: { topic: string; geo?: Geo; expires_in_days?: 7 | 30 | 90 },
): Promise<IntentDTO> => {
	const res = await request.post("/v1/intents", {
		data: {
			raw_text: input.topic,
			form: "connection",
			topic: input.topic,
			geo: input.geo ?? null,
			...(input.expires_in_days !== undefined
				? { expires_in_days: input.expires_in_days }
				: {}),
		},
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `POST /v1/intents(つながり: ${input.topic})`).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** 機会Intentを作成する(status=active・201を保証)。expiresAtMs未指定は既定(start+3時間) */
const createOccasion = async (
	request: APIRequestContext,
	accessToken: string,
	input: {
		topic: string;
		startMs: number;
		endMs?: number;
		geo?: Geo;
	},
	expiresAtMs?: number,
): Promise<IntentDTO> => {
	const res = await request.post("/v1/intents", {
		data: {
			raw_text: input.topic,
			form: "occasion",
			topic: input.topic,
			time: {
				start: new Date(input.startMs).toISOString(),
				end:
					input.endMs === undefined
						? null
						: new Date(input.endMs).toISOString(),
			},
			geo: input.geo ?? null,
			...(expiresAtMs !== undefined
				? { expires_at: new Date(expiresAtMs).toISOString() }
				: {}),
		},
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `POST /v1/intents(機会: ${input.topic})`).toBe(201);
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

/** DELETE /v1/intents/{id}(削除・204を保証) */
const deleteIntent = async (
	request: APIRequestContext,
	accessToken: string,
	id: string,
): Promise<void> => {
	const res = await request.delete(`/v1/intents/${id}`, {
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `DELETE /v1/intents/${id}`).toBe(204);
};

/** 観測APIの一覧をcursor末尾まで全件取得する(観測対象は1ケースあたり少数) */
const listObserveAll = async <T extends { id: string }>(
	request: APIRequestContext,
	accessToken: string,
	path: string,
	intentId: string,
): Promise<T[]> => {
	const items: T[] = [];
	let cursor: string | null = null;
	for (;;) {
		const params = new URLSearchParams({ intent_id: intentId, limit: "50" });
		if (cursor !== null) {
			params.set("cursor", cursor);
		}
		const res = await request.get(`/v1/dev/${path}?${params.toString()}`, {
			headers: authHeaders(accessToken),
		});
		expect(res.status(), `GET /v1/dev/${path}`).toBe(200);
		const body = (await res.json()) as PageBody<T>;
		items.push(...body.items);
		cursor = body.next_cursor;
		if (cursor === null) {
			return items;
		}
	}
};

/** 指定Intentを起点とするmatch_eventsを全件取得する */
const listEvents = (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
): Promise<MatchEventItem[]> =>
	listObserveAll<MatchEventItem>(
		request,
		accessToken,
		"match-events",
		intentId,
	);

/** 指定Intentを含む1対1評価候補を全件取得する */
const listCandidates = (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
): Promise<MatchCandidateItem[]> =>
	listObserveAll<MatchCandidateItem>(
		request,
		accessToken,
		"match-candidates",
		intentId,
	);

/**
 * 指定Intentのversionのembedding_completedイベントがprocessedになるまで待ち、
 * そのイベントを返す(docs/06 §2: 第1段が完了すると同versionで再投入され、
 * 第2段の消費でpayloadに計測結果が載ってprocessedになる)
 */
const waitForEvaluation = async (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
	version: number,
): Promise<MatchEventItem> => {
	const find = async (): Promise<MatchEventItem | undefined> => {
		const events = await listEvents(request, accessToken, intentId);
		return events.find(
			(e) =>
				e.event_type === "embedding_completed" &&
				e.version === version &&
				e.status === "processed",
		);
	};
	await waitFor(async () => (await find()) !== undefined, 60_000, 500);
	const event = await find();
	expect(
		event,
		`embedding_completed v${version}の処理済みイベント`,
	).toBeDefined();
	return event as MatchEventItem;
};

/**
 * ペア(a<b正規化・docs/05 §2.2)に一致する候補行を探す。候補行は
 * intent_a_id<intent_b_idに正規化して保存されるため、順序の組合せ両方で照合する
 */
const findPairRow = (
	rows: MatchCandidateItem[],
	idA: string,
	idB: string,
): MatchCandidateItem | undefined =>
	rows.find(
		(r) =>
			(r.intent_a_id === idA && r.intent_b_id === idB) ||
			(r.intent_a_id === idB && r.intent_b_id === idA),
	);

// パイプラインの観測はキュー消費とCron発火の反映を待つため、既定の30秒では
// 足りない。全ケースに2分を与える(#6のdescribeは別途300秒へ延長)
test.setTimeout(120_000);

test.describe("#6 両形式に有効期限を設定できる", () => {
	// 実時間で期限の到来(作成+2分)を待つため300秒を与える(10 §3)
	test.setTimeout(300_000);

	test("機会Intent: 明示期限の経過後にexpiredへ遷移する", async ({
		request,
	}) => {
		const { access_token } = await registerUser(request, "E2E期限機会");
		// starts_at=now+45秒・明示expires_at=now+2分(seedで期限を近未来に置く・10 §3)
		const occasion = await createOccasion(
			request,
			access_token,
			{
				topic: "すぐ始まるボードゲーム会",
				startMs: Date.now() + 45_000,
			},
			Date.now() + 2 * 60_000,
		);
		// 期限切れ前にパイプラインが一巡していることを先に確定させる
		await waitForEvaluation(request, access_token, occasion.id, 1);
		// 10秒間隔でCronを強制発火しながら最大3分待つ(02 §4の#6検証方法)
		await waitFor(
			async () => {
				await runCron(request);
				return (
					(await getIntent(request, access_token, occasion.id)).status ===
					"expired"
				);
			},
			180_000,
			10_000,
		);
		// 合格証拠: Intentがexpiredに遷移している(期限切れ2窓の第1窓・05 §2.6)
		expect((await getIntent(request, access_token, occasion.id)).status).toBe(
			"expired",
		);
		await deleteIntent(request, access_token, occasion.id);
	});

	test("つながりIntent: expires_in_days=7/30/90がactive化時刻+日数で保存される", async ({
		request,
	}) => {
		const { access_token } = await registerUser(request, "E2E期限つながり");
		const created: IntentDTO[] = [];
		for (const days of EXPIRY_CHOICES_DAYS) {
			const beforeMs = Date.now();
			const dto = await createConnection(request, access_token, {
				topic: `期限${days}日のテスト仲間募集`,
				expires_in_days: days,
			});
			const afterMs = Date.now();
			created.push(dto);
			// 合格証拠: 保存値がactive化時刻+選択日数(±1時間の許容・05 §2.2)
			expect(dto.expires_at).not.toBeNull();
			const expiresMs = new Date(dto.expires_at as string).getTime();
			expect(expiresMs).toBeGreaterThanOrEqual(
				beforeMs + days * MS_PER_DAY - MS_PER_HOUR,
			);
			expect(expiresMs).toBeLessThanOrEqual(
				afterMs + days * MS_PER_DAY + MS_PER_HOUR,
			);
		}
		// 期限+7日のベクトル削除(05 §2.6の第2窓)など日数経過そのものの遷移は、
		// 注入clockの統合試験(pipeline-cron.test.ts)が決定的に証明する。E2Eは
		// 実時間の制約(10 §3)により、この保存値の確認と機会のexpired遷移に分割
		await waitForEvaluation(request, access_token, created[0].id, 1);
		for (const dto of created) {
			await deleteIntent(request, access_token, dto.id);
		}
	});
});

test("#7 全件総当たりを行わない(取得件数は投入数に線形・判定件数は上限内)", async ({
	request,
}) => {
	const userA = await registerUser(request, "E2E線形A");
	const userB = await registerUser(request, "E2E線形B");
	// 2ユーザーでつながりIntent計6件を段階投入(3件→対象評価→3件追加→別対象評価)。
	// 1件作成するごとに直前までの評価の完了を待つため、各評価のpayloadの
	// retrieval_count(自idを含む取得件数・docs/06 §7)は「その時点のactiveな
	// つながりベクトル数」と一致する
	const created: IntentDTO[] = [];
	const payloads: Stage2Payload[] = [];
	for (const user of [userA, userA, userA, userB, userB, userB]) {
		const index = payloads.length;
		const dto = await createConnection(request, user.access_token, {
			topic: `線形性の確認用のつながり${index + 1}`,
		});
		created.push(dto);
		const event = await waitForEvaluation(
			request,
			user.access_token,
			dto.id,
			1,
		);
		expect(isStage2Payload(event.payload), "計測payload").toBe(true);
		payloads.push(event.payload as Stage2Payload);
	}
	const p1 = payloads[0];
	const p3 = payloads[2];
	const p6 = payloads[5];
	// 合格証拠: 取得件数がIntent数に応じて急増しない(線形)。
	// クリーンなベクトルストアでは3件目の評価=3・6件目=6になる。同一サーバーで
	// 先行実行したspec(intents.spec.ts等)が残したactiveベクトルが混入する環境
	// (ローカルD1は実行間で永続)では共通のベースラインぶんだけずれるため、
	// 差分(1件の作成ごとに+1)と下限で線形性を検証する
	expect(p3.retrieval_count).toBe(p1.retrieval_count + 2);
	expect(p6.retrieval_count).toBe(p1.retrieval_count + 5);
	expect(p3.retrieval_count).toBeGreaterThanOrEqual(3);
	expect(p6.retrieval_count).toBeGreaterThanOrEqual(6);
	// 合格証拠: Layer 1通過後の引き渡し上限(K_v=50)とLayer 3の保存上限(K_c=20)。
	// 上限値はPIPELINEの定数由来(docs/06 §3)。1イベントあたりの判定件数は
	// 投入数に比例せず上限で頭打ちになる。本格的な負荷試験(10 §5)はF8で実施する
	for (const payload of [p3, p6]) {
		expect(payload.l1_pass).toBeLessThanOrEqual(PIPELINE.LAYER1_OUTPUT_MAX);
		expect(payload.l3_pass).toBeLessThanOrEqual(PIPELINE.LAYER3_OUTPUT_MAX);
	}
	for (const [index, dto] of created.entries()) {
		const owner = index < 3 ? userA : userB;
		await deleteIntent(request, owner.access_token, dto.id);
	}
});

test("#8 新規Intentから既存Intentを検索できる", async ({ request }) => {
	// 既存つながりを配置してから新規つながりを登録する(02 §4の#8検証方法)
	const userA = await registerUser(request, "E2E既存配置");
	const existing = await createConnection(request, userA.access_token, {
		topic: "写真サークルの仲間を募集しています",
	});
	await waitForEvaluation(request, userA.access_token, existing.id, 1);
	const userB = await registerUser(request, "E2E新規登録");
	const fresh = await createConnection(request, userB.access_token, {
		topic: "写真を撮る仲間が欲しいです",
	});
	await waitForEvaluation(request, userB.access_token, fresh.id, 1);
	// 合格証拠: 既存Intentを含むMatchCandidateの生成記録。
	// ペアはa<b正規化で保存される(docs/05 §2.2)
	for (const viewer of [
		{ token: userA.access_token, id: existing.id },
		{ token: userB.access_token, id: fresh.id },
	]) {
		const rows = await listCandidates(request, viewer.token, viewer.id);
		const row = findPairRow(rows, existing.id, fresh.id);
		expect(row, "既存Intentを含む候補行").toBeDefined();
		expect(row?.intent_a_id).toBe(
			existing.id < fresh.id ? existing.id : fresh.id,
		);
		expect(row?.intent_b_id).toBe(
			existing.id < fresh.id ? fresh.id : existing.id,
		);
		expect(row?.form).toBe("connection");
		// F4aでLayer 4〜5と提案化が連結され、stub Jev(全軸0.9・docs/07 §2(b))の
		// ペアは提案まで進んでproposedになる(設計どおり)。#8の証拠は候補行の
		// 生成記録そのものであるため、提案化の前後どちらの状態でも合格とする
		expect(["candidate", "proposed"]).toContain(row?.status);
		expect(row?.intent_a_version).toBe(1);
		expect(row?.intent_b_version).toBe(1);
		expect(typeof row?.retrieval_score).toBe("number");
		expect(typeof row?.cheap_judge_score).toBe("number");
	}
	await deleteIntent(request, userA.access_token, existing.id);
	await deleteIntent(request, userB.access_token, fresh.id);
});

test("#9 意味的近接ペアを候補化できる", async ({ request }) => {
	// 語彙が一致しない意味的近接ペア(02 §4の#9検証方法)。stubベクトルは語の
	// 意味を持たないため、候補化は「検索の取り出し幅(topK=100)が少数コーパスの
	// 当該ペアを確実に含む」ことで成立する(10 §3のseed方針・ファイル冒頭コメント)
	const userC = await registerUser(request, "E2E意味近接C");
	const c = await createConnection(request, userC.access_token, {
		topic: "個人開発仲間が欲しい",
	});
	await waitForEvaluation(request, userC.access_token, c.id, 1);
	const userD = await registerUser(request, "E2E意味近接D");
	const d = await createConnection(request, userD.access_token, {
		topic: "Railsで何か作っている人と繋がりたい",
	});
	await waitForEvaluation(request, userD.access_token, d.id, 1);
	// 合格証拠: 候補として生成される
	const rows = await listCandidates(request, userD.access_token, d.id);
	expect(findPairRow(rows, c.id, d.id)).toBeDefined();
	await deleteIntent(request, userC.access_token, c.id);
	await deleteIntent(request, userD.access_token, d.id);
});

test("#10 地理非添付ペア(全国)を候補化できる", async ({ request }) => {
	// 双方が地理非添付のつながりIntent(02 §4の#10検証方法)。地理が
	// 候補化を阻害していないこと(片方のみ・双方未添付は全国スコープで
	// 判定しない・docs/01 §12)を候補の生成で確認する
	const userE = await registerUser(request, "E2E全国E");
	const e = await createConnection(request, userE.access_token, {
		topic: "カフェで作業する仲間を募集しています",
	});
	await waitForEvaluation(request, userE.access_token, e.id, 1);
	const userF = await registerUser(request, "E2E全国F");
	const f = await createConnection(request, userF.access_token, {
		topic: "午後のカフェタイムを過ごす仲間が欲しい",
	});
	await waitForEvaluation(request, userF.access_token, f.id, 1);
	// 合格証拠: 候補が生成される
	const rows = await listCandidates(request, userF.access_token, f.id);
	expect(findPairRow(rows, e.id, f.id)).toBeDefined();
	await deleteIntent(request, userE.access_token, e.id);
	await deleteIntent(request, userF.access_token, f.id);
});

test("#11 つながり×機会のペアは候補化されない", async ({ request }) => {
	// 主題が一致するつながりIntent×機会Intentを配置する(02 §4の#11検証方法)。
	// つながり(評価済み)→機会→別ユーザーのつながりの順で投入し、
	// 3件目の評価の取得件数の差分で「主題が一致しても異formは検索の
	// 取り出しに含まれないこと(Layer 2 Candidate Retrievalのfilter・
	// docs/06 §3)」を黒箱で証明する。
	// Layer 1の除外理由form_mismatchの記録そのものは、filterが上流で異formを
	// 除くため実経路では発生しない(activeなIntentのform変更は不可・05 §3.2)。
	// この記録は直接seedによる統合試験(pipeline-evaluate.test.tsの#11相当)が
	// 証明する(E2Eからは届かない経路のため)
	const userG = await registerUser(request, "E2Eform分離G");
	const g = await createConnection(request, userG.access_token, {
		topic: "ボードゲーム会の仲間を募集しています",
	});
	const gPayload = await waitForEvaluation(
		request,
		userG.access_token,
		g.id,
		1,
	);
	expect(isStage2Payload(gPayload.payload)).toBe(true);
	const userH = await registerUser(request, "E2Eform分離H");
	const h = await createOccasion(request, userH.access_token, {
		topic: "ボードゲーム会を今夜開催します",
		startMs: Date.now() + 2 * MS_PER_HOUR,
		endMs: Date.now() + 4 * MS_PER_HOUR,
		geo: { center: { lat: 35.6938, lng: 139.7034 }, radius_m: 2000 },
	});
	await waitForEvaluation(request, userH.access_token, h.id, 1);
	const userI = await registerUser(request, "E2Eform分離I");
	const i = await createConnection(request, userI.access_token, {
		topic: "ボードゲーム会に週末参加したいです",
	});
	const iEvent = await waitForEvaluation(request, userI.access_token, i.id, 1);
	expect(isStage2Payload(iEvent.payload)).toBe(true);
	const iPayload = iEvent.payload as Stage2Payload;
	const gStage2 = gPayload.payload as Stage2Payload;
	// 合格証拠: つながりの検索取り出しには、主題が一致する機会Intentは含まれず
	// つながりだけが増える(取得件数の増分=つながり1件ぶんのみ)
	expect(iPayload.retrieval_count).toBe(gStage2.retrieval_count + 1);
	// 合格証拠: 異formのペア(つながり×機会)の候補行は生成されない
	for (const connectionId of [g.id, i.id]) {
		const rows = await listCandidates(request, userH.access_token, h.id);
		expect(findPairRow(rows, connectionId, h.id)).toBeUndefined();
	}
	await deleteIntent(request, userG.access_token, g.id);
	await deleteIntent(request, userH.access_token, h.id);
	await deleteIntent(request, userI.access_token, i.id);
});

test("#13 Hard Constraintをコードで除外できる(自己ペア・地理の重なりなし)", async ({
	request,
}) => {
	// 02 §4の#13検証方法のうち、APIだけで配置できる自己ペアと地理添付の
	// 重なりなしを狙う。ブロック・提案履歴・飲酒年齢は対象APIが未実装
	// (blocks/提案はF4以降)・18〜19歳では飲酒Intentを作成できない(05 §3.1)
	// ため、直接seedによる統合試験(pipeline-evaluate.test.tsの#13相当)が
	// 証明する(E2Eは「いずれの候補にも現れない」ことの黒箱確認のみ)

	// (a) 自己ペア: 同一ユーザーの2 Intentは候補にならない
	const userJ = await registerUser(request, "E2E自己ペア");
	const j1 = await createConnection(request, userJ.access_token, {
		topic: "釣り仲間を募集しています",
	});
	await waitForEvaluation(request, userJ.access_token, j1.id, 1);
	const j2 = await createConnection(request, userJ.access_token, {
		topic: "海釣りに行きたいです",
	});
	const j2Event = await waitForEvaluation(
		request,
		userJ.access_token,
		j2.id,
		1,
	);
	expect(isStage2Payload(j2Event.payload)).toBe(true);
	const j2Payload = j2Event.payload as Stage2Payload;
	// 合格証拠: 自己ペアはLayer 1で除外される(除外理由別内訳・docs/06 §7)
	expect(j2Payload.l1_exclusions.self_pair).toBeGreaterThanOrEqual(1);
	const jRows = await listCandidates(request, userJ.access_token, j2.id);
	expect(findPairRow(jRows, j1.id, j2.id)).toBeUndefined();

	// (b) 地理が離れた機会2件は候補にならない(同一時間帯・東京と大阪)
	const userK = await registerUser(request, "E2E地理K");
	const k = await createOccasion(request, userK.access_token, {
		topic: "夕方のランニング会に参加しませんか",
		startMs: Date.now() + 2 * MS_PER_HOUR,
		endMs: Date.now() + 4 * MS_PER_HOUR,
		geo: { center: { lat: 35.6812, lng: 139.7671 }, radius_m: 1000 },
	});
	await waitForEvaluation(request, userK.access_token, k.id, 1);
	const userL = await registerUser(request, "E2E地理L");
	const l = await createOccasion(request, userL.access_token, {
		topic: "同じ夕方のランニング会を催します",
		startMs: Date.now() + 2 * MS_PER_HOUR,
		endMs: Date.now() + 4 * MS_PER_HOUR,
		geo: { center: { lat: 34.6937, lng: 135.5023 }, radius_m: 1000 },
	});
	const lEvent = await waitForEvaluation(request, userL.access_token, l.id, 1);
	expect(isStage2Payload(lEvent.payload)).toBe(true);
	const lPayload = lEvent.payload as Stage2Payload;
	// 合格証拠: 時間は重なるが地域が重ならないペアはgeo_no_overlapで除外される
	expect(lPayload.l1_exclusions.geo_no_overlap).toBeGreaterThanOrEqual(1);
	const lRows = await listCandidates(request, userL.access_token, l.id);
	expect(findPairRow(lRows, k.id, l.id)).toBeUndefined();

	await deleteIntent(request, userJ.access_token, j1.id);
	await deleteIntent(request, userJ.access_token, j2.id);
	await deleteIntent(request, userK.access_token, k.id);
	await deleteIntent(request, userL.access_token, l.id);
});

test("補助: PATCH後の候補は新versionで作られ・DELETEで候補とイベントが空になる", async ({
	request,
}) => {
	const userM = await registerUser(request, "E2E更新M");
	const m = await createConnection(request, userM.access_token, {
		topic: "釣り仲間を募集しています",
	});
	await waitForEvaluation(request, userM.access_token, m.id, 1);
	const userN = await registerUser(request, "E2E更新N");
	const n = await createConnection(request, userN.access_token, {
		topic: "海釣りの仲間を探しています",
	});
	await waitForEvaluation(request, userN.access_token, n.id, 1);
	expect(
		findPairRow(
			await listCandidates(request, userM.access_token, m.id),
			m.id,
			n.id,
		),
	).toBeDefined();

	// PATCH topic → version+1。更新イベントは10秒遅延で投入される(docs/06 §2)
	const patched = await patchIntent(request, userM.access_token, m.id, {
		topic: "渓流釣りの仲間を募集しています",
	});
	expect(patched.version).toBe(2);
	// 意味フィールドの更新で30分の再評価抑制は解除されるため(オーナー裁定 2026-10-20・
	// docs/06 §3)、PATCH後の自己再評価はskipされずに新versionで走る。v2の
	// embedding_completedがprocessedになるまで待つことは、10秒遅延の更新イベントが
	// 第1段(再埋め込み)まで処理されたことの確認にもなる。続けて
	// 「PATCH後の別Intentの評価が新version行を作る」ことも確かめる
	// (統合試験pipeline-evaluate.test.tsと同一の挙動)
	const v2Event = await waitForEvaluation(request, userM.access_token, m.id, 2);
	expect(v2Event.payload).not.toHaveProperty("skipped");
	expect(v2Event.payload).toHaveProperty("retrieval_count");
	const userO = await registerUser(request, "E2E更新O");
	const o = await createConnection(request, userO.access_token, {
		topic: "渓流釣りのメンバーを募集しています",
	});
	await waitForEvaluation(request, userO.access_token, o.id, 1);
	// 合格証拠: 新version(v2)の候補行が作られ・旧version(v1)の行も残る
	// (UNIQUE(a,b,va,vb)単位のため併存する・docs/05 §2.2)
	const mRows = await listCandidates(request, userM.access_token, m.id);
	const rowV2 = findPairRow(mRows, m.id, o.id);
	expect(rowV2).toBeDefined();
	expect(
		rowV2?.intent_a_id === m.id
			? rowV2.intent_a_version
			: rowV2?.intent_b_version,
	).toBe(2);
	expect(findPairRow(mRows, m.id, n.id)).toBeDefined();
	// 合格証拠: DELETEにより当該Intentを含む候補とイベントが空になる
	// (docs/05 §2.5の無条件削除)
	await deleteIntent(request, userM.access_token, m.id);
	expect(await listCandidates(request, userM.access_token, m.id)).toEqual([]);
	expect(await listEvents(request, userM.access_token, m.id)).toEqual([]);
	await deleteIntent(request, userN.access_token, n.id);
	await deleteIntent(request, userO.access_token, o.id);
});
