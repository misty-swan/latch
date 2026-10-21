/**
 * 提案〜成立のE2E(APIレベル・docs/02 §4の#12・#14・#15・#17〜#20・#23・F4aのゲートと
 * #21・F5のゲート)。
 * Intent APIで実データを投入し、パイプライン(Layer 2 Candidate Retrieval→Layer 1→
 * Layer 3→Layer 4 Jev→Layer 5→提案化)の結果をdev観測API(GET /v1/dev/latches・
 * match-candidates・match-events・proposal-history)と/v1/latchesで読む。
 *
 * seed方針(docs/10 §3): Jevは既定stub(全7軸0.9・docs/07 §2(b))のため、同formで
 * Layer 1を通るペアは必ず提案される(L=0.9>0.60)。提案はユーザーペア単位で1件・
 * 通知上限は1ユーザー1日6件・1Intent同時進行3件・Active Intent上限5件/ユーザーの
 * ため、各testは新規ユーザーで配置する。1つのtestに複数ペアを置くときは、ペアごとに
 * 離れた地域(双方添付で重ならない・Layer 1のgeo_no_overlap)を割り当て、ペアをまたぐ
 * 提案を作らない。機会Intentは対象時刻まで75分未満だと提案されないため、starts_atは
 * now+4時間・双方同じ時間帯(重なり15分以上)に置く。
 *
 * 他specの残置Intentの扱い: wrangler devの1プロセスはインメモリのベクトルストアを
 * 全specで共有し、先行するintents.spec.tsは保存したIntentを残す。地域なしのそれらは
 * 全国スコープでこのspecのIntentとLayer 1を通り、stub Jevで提案されて1Intent同時進行
 * 3件の枠を埋める(対象ペアの提案が保留へ回る)。そこで各testの前に、E2Eユーザーの
 * activeなIntentをexpiredへ倒す(webServer起動時と同じscripts/clean-e2e-data.mjs)。
 * Layer 1はD1の現行statusで判定するため、ベクトルが残っていても候補から外れる。
 * 各testの最後でも作成したIntentをDELETEする(pipeline.spec.tsと同じ後片付け)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { LATCH, type LatchDTO } from "@latch/shared";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	backdate,
	type CreatedIntent,
	createIntent,
	type DevLatchItem,
	listDevLatches,
	type RegisteredUser,
	registerUser,
	respond,
	runCron,
	waitFor,
	waitForLatch,
} from "./helpers";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** GET /v1/dev/match-eventsの1項目(F3計画Task 13の観測契約) */
interface MatchEventItem {
	id: string;
	event_type: string;
	version: number;
	status: string;
	payload: unknown;
}

/** GET /v1/dev/match-candidatesの1項目(F4aでjev_result・latch_scoreを追加) */
interface MatchCandidateItem {
	id: string;
	intent_a_id: string;
	intent_b_id: string;
	jev_result: Record<string, number> | null;
	latch_score: number | null;
	status: string;
}

/** GET /v1/dev/proposal-historyの1項目 */
interface ProposalHistoryItem {
	user_low: string;
	user_high: string;
	latch_id: string;
	outcome: string;
}

/** embedding_completedのpayload(第2段の計測・docs/06 §7・F4aでJev以降を追加) */
interface Stage2Payload {
	retrieval_count: number;
	l1_pass: number;
	l1_exclusions: Record<string, number>;
	l3_pass: number;
	jev_calls: number;
	jev_reused: number;
	jev_held: { budget: number; breaker: number; failed: number; cap: number };
	l5_over_threshold: number;
	proposed: number;
	held_proposals: number;
}

const isStage2Payload = (payload: unknown): payload is Stage2Payload =>
	typeof payload === "object" &&
	payload !== null &&
	typeof (payload as Stage2Payload).jev_calls === "number";

const authHeaders = (accessToken: string): Record<string, string> => ({
	authorization: `Bearer ${accessToken}`,
});

/** docs/05 §2.2(geo)の地域添付 */
interface Geo {
	center: { lat: number; lng: number };
	radius_m: number;
}

/**
 * test・ペアごとの地域(半径1km)。番号ごとに緯度を0.1度(約11km)ずらすため、
 * 異なる番号同士は双方添付で重ならない(Layer 1のgeo_no_overlap)
 */
const site = (n: number): Geo => ({
	center: { lat: 33 + n * 0.1, lng: 131.5 },
	radius_m: 1_000,
});

/** 他specが残したE2EユーザーのactiveなIntentをexpiredへ倒す(ファイル冒頭コメント) */
const expireLeftoverE2eIntents = (): void => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: path.join(import.meta.dirname, ".."),
		stdio: "ignore",
	});
};

/** つながりIntentを作成する */
const createConnection = (
	request: APIRequestContext,
	user: RegisteredUser,
	topic: string,
	geo: Geo,
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: topic,
		form: "connection",
		topic,
		geo,
	});

/** 機会Intentを作成する(starts_at=startMs・ends_at=startMs+2時間) */
const createOccasion = (
	request: APIRequestContext,
	user: RegisteredUser,
	topic: string,
	geo: Geo,
	startMs: number,
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: topic,
		form: "occasion",
		topic,
		time: {
			start: new Date(startMs).toISOString(),
			end: new Date(startMs + 2 * MS_PER_HOUR).toISOString(),
		},
		geo,
	});

/** 観測APIの一覧(1ケースあたり少数のためlimit=50の1ページで足りる) */
const listObserve = async <T>(
	request: APIRequestContext,
	accessToken: string,
	pathAndQuery: string,
): Promise<T[]> => {
	const res = await request.get(`/v1/dev/${pathAndQuery}&limit=50`, {
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `GET /v1/dev/${pathAndQuery}`).toBe(200);
	return ((await res.json()) as { items: T[] }).items;
};

/**
 * 指定versionのembedding_completedがprocessedになるまで待ち、そのイベントを返す
 * (第2段の評価=提案化までが完了し、payloadに計測が載った時点・docs/06 §7)
 */
const waitForEvaluation = async (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
	version: number,
	timeout = 60_000,
): Promise<MatchEventItem> => {
	let found: MatchEventItem | undefined;
	await waitFor(
		async () => {
			const events = await listObserve<MatchEventItem>(
				request,
				accessToken,
				`match-events?intent_id=${intentId}`,
			);
			found = events.find(
				(e) =>
					e.event_type === "embedding_completed" &&
					e.version === version &&
					e.status === "processed",
			);
			return found !== undefined;
		},
		timeout,
		500,
	);
	return found as MatchEventItem;
};

/** GET /v1/latches/{id}(参加者として取得・200を保証) */
const getLatch = async (
	request: APIRequestContext,
	accessToken: string,
	latchId: string,
): Promise<LatchDTO> => {
	const res = await request.get(`/v1/latches/${latchId}`, {
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `GET /v1/latches/${latchId}`).toBe(200);
	return (await res.json()) as LatchDTO;
};

/** 指定ユーザーの提案履歴(ペア単位の1行・outcome) */
const historyOf = (
	request: APIRequestContext,
	user: RegisteredUser,
): Promise<ProposalHistoryItem[]> =>
	listObserve<ProposalHistoryItem>(
		request,
		user.access_token,
		`proposal-history?user_id=${user.user.id}`,
	);

/** DELETE /v1/intents/{id}(後片付け・204を保証) */
const deleteIntent = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<void> => {
	const res = await request.delete(`/v1/intents/${intentId}`, {
		headers: authHeaders(user.access_token),
	});
	expect(res.status(), `DELETE /v1/intents/${intentId}`).toBe(204);
};

/** LATCHが2 Intentのペアか */
const isPairOf =
	(x: CreatedIntent, y: CreatedIntent) =>
	(item: DevLatchItem): boolean =>
		item.intent_ids.includes(x.id) && item.intent_ids.includes(y.id);

/** 配置した1ペア(a=先に作成した側・b=後から作成した側) */
interface Pair {
	a: RegisteredUser;
	b: RegisteredUser;
	x: CreatedIntent;
	y: CreatedIntent;
	latch: DevLatchItem;
}

/**
 * 新規ユーザー2人に同じ主題・同じ地域のIntentを1件ずつ作り、ペアの提案(proposed)を
 * 待って返す。作成は先の評価の完了を待ってから次を作る(検索に先の側を確実に含める)
 */
const proposePair = async (
	request: APIRequestContext,
	label: string,
	create: (user: RegisteredUser) => Promise<CreatedIntent>,
): Promise<Pair> => {
	const a = await registerUser(request, `E2E${label}A`);
	const x = await create(a);
	await waitForEvaluation(request, a.access_token, x.id, 1);
	const b = await registerUser(request, `E2E${label}B`);
	const y = await create(b);
	await waitForEvaluation(request, b.access_token, y.id, 1);
	const latch = await waitForLatch(
		request,
		a.access_token,
		x.id,
		isPairOf(x, y),
	);
	expect(latch.status, `${label}のペアの提案`).toBe("proposed");
	return { a, b, x, y, latch };
};

/** ペアの2 Intentを削除する */
const deletePair = async (
	request: APIRequestContext,
	pair: Pair,
): Promise<void> => {
	await deleteIntent(request, pair.a, pair.x.id);
	await deleteIntent(request, pair.b, pair.y.id);
};

// 提案の観測はキュー消費の反映を待つため既定の30秒では足りない
test.setTimeout(180_000);

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test("#14 1イベントのJev実行回数が8回以下", async ({ request }) => {
	// 同一主題・同一地域のつながりIntentを別ユーザー12人で1件ずつ作る。最後の
	// Intentの評価では先の11件が一次候補になり、K_j=8を超える
	test.setTimeout(300_000);
	const topic = "週末に一緒に将棋を指す仲間を募集しています";
	const created: { user: RegisteredUser; intent: CreatedIntent }[] = [];
	let last: MatchEventItem | undefined;
	for (let i = 0; i < 12; i++) {
		const user = await registerUser(request, `E2EJev上限${i + 1}`);
		const intent = await createConnection(request, user, topic, site(1));
		created.push({ user, intent });
		last = await waitForEvaluation(request, user.access_token, intent.id, 1);
	}
	expect(isStage2Payload(last?.payload), "最後の起点イベントの計測").toBe(true);
	const payload = last?.payload as Stage2Payload;
	// 前提: Jevへ渡り得る一次候補(Layer 3通過)がK_jを超えている
	expect(payload.l3_pass).toBeGreaterThan(LATCH.JEV_CALLS_PER_EVENT);
	// 合格証拠(#14): 1イベントのJev実行回数がK_j=8を超えず、超過分は呼び出し枠で保留される
	expect(payload.jev_calls).toBeLessThanOrEqual(LATCH.JEV_CALLS_PER_EVENT);
	expect(payload.jev_held.cap).toBeGreaterThan(0);
	for (const { user, intent } of created) {
		await deleteIntent(request, user, intent.id);
	}
});

test("#15 双方向の判定値が記録される", async ({ request }) => {
	const pair = await proposePair(request, "双方向", (user) =>
		createConnection(
			request,
			user,
			"朝のジョギング仲間を探しています",
			site(2),
		),
	);
	const rows = await listObserve<MatchCandidateItem>(
		request,
		pair.b.access_token,
		`match-candidates?intent_id=${pair.y.id}`,
	);
	const row = rows.find(
		(r) =>
			(r.intent_a_id === pair.x.id && r.intent_b_id === pair.y.id) ||
			(r.intent_a_id === pair.y.id && r.intent_b_id === pair.x.id),
	);
	expect(row, "ペアの候補行").toBeDefined();
	// 合格証拠(#15): A→B・B→A双方の判定値(数値のみ)が候補行に記録される
	expect(typeof row?.jev_result?.would_a_accept_b).toBe("number");
	expect(typeof row?.jev_result?.would_b_accept_a).toBe("number");
	// LATCH Scoreは双方向の最小値から計算され、提案のscoreと一致する(docs/06 §6)
	expect(row?.latch_score).toBe(
		Math.min(
			row?.jev_result?.would_a_accept_b ?? 0,
			row?.jev_result?.would_b_accept_a ?? 0,
		),
	);
	expect(row?.status).toBe("proposed");
	expect(pair.latch.score).toBe(row?.latch_score);
	await deletePair(request, pair);
});

test("#17/#18 yes・deferの回答と双方YESの成立", async ({ request }) => {
	// (1) 双方yes: A yes→partial_accept・B yes→matched
	const yesPair = await proposePair(request, "双方yes", (user) =>
		createConnection(request, user, "読書会を一緒に開く仲間が欲しい", site(3)),
	);
	const afterA = await respond(
		request,
		yesPair.a.access_token,
		yesPair.latch.id,
		"yes",
	);
	// 合格証拠(#17): 回答の記録(my_response)と状態遷移(proposed→partial_accept)
	expect(afterA.status).toBe("partial_accept");
	expect(afterA.my_response).toBe("yes");
	const seenByB = await getLatch(
		request,
		yesPair.b.access_token,
		yesPair.latch.id,
	);
	expect(seenByB.status).toBe("partial_accept");
	expect(seenByB.my_response).toBeNull();
	const afterB = await respond(
		request,
		yesPair.b.access_token,
		yesPair.latch.id,
		"yes",
	);
	// 合格証拠(#18): 双方YESでmatchedへ遷移し、相手情報が解放される
	expect(afterB.status).toBe("matched");
	expect(afterB.my_response).toBe("yes");
	expect(afterB.members?.map((m) => m.user_id)).toEqual([yesPair.a.user.id]);
	expect(
		(await getLatch(request, yesPair.a.access_token, yesPair.latch.id)).status,
	).toBe("matched");
	const yesHistory = (await historyOf(request, yesPair.a)).find(
		(h) => h.latch_id === yesPair.latch.id,
	);
	expect(yesHistory?.outcome).toBe("matched");

	// (2) defer(UIの[今回は見送る])→rejected
	const deferPair = await proposePair(request, "見送り", (user) =>
		createConnection(request, user, "陶芸を一緒に習う仲間を募集中", site(4)),
	);
	const deferred = await respond(
		request,
		deferPair.b.access_token,
		deferPair.latch.id,
		"defer",
	);
	// 合格証拠(#17): deferの記録とrejected遷移(履歴はdeferred)
	expect(deferred.status).toBe("rejected");
	expect(deferred.my_response).toBe("defer");
	const deferHistory = (await historyOf(request, deferPair.b)).find(
		(h) => h.latch_id === deferPair.latch.id,
	);
	expect(deferHistory?.outcome).toBe("deferred");

	// (3) noはUIに置かずAPI直叩きのみ→rejected(履歴はrejected=恒久排除)
	const noPair = await proposePair(request, "拒否", (user) =>
		createConnection(
			request,
			user,
			"社会人バンドのメンバーを探しています",
			site(5),
		),
	);
	const rejected = await respond(
		request,
		noPair.a.access_token,
		noPair.latch.id,
		"no",
	);
	// 合格証拠(#17): noの記録とrejected遷移
	expect(rejected.status).toBe("rejected");
	expect(rejected.my_response).toBe("no");
	const noHistory = (await historyOf(request, noPair.a)).find(
		(h) => h.latch_id === noPair.latch.id,
	);
	expect(noHistory?.outcome).toBe("rejected");

	await deletePair(request, yesPair);
	await deletePair(request, deferPair);
	await deletePair(request, noPair);
});

test("#20 成立後のみ詳細を解放", async ({ request }) => {
	const pair = await proposePair(request, "解放", (user) =>
		createConnection(request, user, "休日に美術館を巡る仲間が欲しい", site(6)),
	);
	// 合格証拠(#20): 成立前(proposed・partial_accept)はproposal・membersのキー自体が無い
	for (const user of [pair.a, pair.b]) {
		const before = await getLatch(request, user.access_token, pair.latch.id);
		expect(before.status).toBe("proposed");
		expect(before).not.toHaveProperty("proposal");
		expect(before).not.toHaveProperty("members");
		expect(before.participants_count).toBe(2);
	}
	const partial = await respond(
		request,
		pair.a.access_token,
		pair.latch.id,
		"yes",
	);
	expect(partial.status).toBe("partial_accept");
	expect(partial).not.toHaveProperty("proposal");
	expect(partial).not.toHaveProperty("members");
	const partialSeenByB = await getLatch(
		request,
		pair.b.access_token,
		pair.latch.id,
	);
	expect(partialSeenByB).not.toHaveProperty("proposal");
	expect(partialSeenByB).not.toHaveProperty("members");

	await respond(request, pair.b.access_token, pair.latch.id, "yes");
	// 合格証拠(#20): 成立後は双方にproposalと自分を除くmembersが解放される
	for (const [viewer, other] of [
		[pair.a, pair.b],
		[pair.b, pair.a],
	] as const) {
		const after = await getLatch(request, viewer.access_token, pair.latch.id);
		expect(after.status).toBe("matched");
		expect(after.proposal?.topic).toBe("休日に美術館を巡る仲間が欲しい");
		expect(after.members).toHaveLength(1);
		expect(after.members?.[0]?.user_id).toBe(other.user.id);
		expect(after.members?.[0]?.display_name).toBe(other.user.display_name);
	}
	await deletePair(request, pair);
});

test("#19 回答期限切れ(両形式)", async ({ request }) => {
	const connection = await proposePair(request, "期限つながり", (user) =>
		createConnection(request, user, "毎週末に釣りへ行く仲間を募集", site(7)),
	);
	const startMs = Date.now() + 4 * MS_PER_HOUR;
	const occasion = await proposePair(request, "期限機会", (user) =>
		createOccasion(
			request,
			user,
			"夕方に川沿いでバーベキュー",
			site(8),
			startMs,
		),
	);
	// 回答期限の式(docs/01 §10): つながり=提示+24時間(Intent期限の方が遠い)・
	// 機会=min(max(提示+15分, min(提示+2時間, 対象時刻−60分)), Intent期限の最小)。
	// 対象時刻は提示の約4時間後のため、機会は提示+2時間になる
	for (const [pair, durationMs] of [
		[connection, 24 * MS_PER_HOUR],
		[occasion, 2 * MS_PER_HOUR],
	] as const) {
		const proposedAt = pair.latch.proposed_at;
		expect(proposedAt).not.toBeNull();
		expect(new Date(pair.latch.response_deadline).getTime()).toBe(
			new Date(proposedAt as string).getTime() + durationMs,
		);
	}
	// 期限を過去へ書き換えてCronの回答期限切れ走査を発火する(実時間で待たない・10 §3)
	const pastIso = new Date(Date.now() - MS_PER_MINUTE).toISOString();
	for (const pair of [connection, occasion]) {
		await backdate(request, pair.a.access_token, pair.latch.id, {
			response_deadline: pastIso,
		});
	}
	await runCron(request);
	// 合格証拠(#19): 両形式の提案がexpiredで閉じ、履歴もexpiredになる
	for (const pair of [connection, occasion]) {
		const dto = await getLatch(request, pair.b.access_token, pair.latch.id);
		expect(dto.status).toBe("expired");
		const history = (await historyOf(request, pair.a)).find(
			(h) => h.latch_id === pair.latch.id,
		);
		expect(history?.outcome).toBe("expired");
	}
	await deletePair(request, connection);
	await deletePair(request, occasion);
});

test("#23 機会の排他", async ({ request }) => {
	const startMs = Date.now() + 4 * MS_PER_HOUR;
	const topic = "今夜の天体観測に一緒に行きませんか";
	const userA = await registerUser(request, "E2E排他A");
	const x = await createOccasion(request, userA, topic, site(9), startMs);
	await waitForEvaluation(request, userA.access_token, x.id, 1);
	const userB = await registerUser(request, "E2E排他B");
	const y = await createOccasion(request, userB, topic, site(9), startMs);
	await waitForEvaluation(request, userB.access_token, y.id, 1);
	const userC = await registerUser(request, "E2E排他C");
	const z = await createOccasion(request, userC, topic, site(9), startMs);
	await waitForEvaluation(request, userC.access_token, z.id, 1);
	// 同一の機会Intent Xを含む2つの成立可能な提案(A-B・A-C)
	const ab = await waitForLatch(
		request,
		userA.access_token,
		x.id,
		isPairOf(x, y),
	);
	const ac = await waitForLatch(
		request,
		userA.access_token,
		x.id,
		isPairOf(x, z),
	);
	expect(ab.status).toBe("proposed");
	expect(ac.status).toBe("proposed");
	// A-Cは片側だけyesを入れて成立可能な状態にしておく
	expect(
		(await respond(request, userC.access_token, ac.id, "yes")).status,
	).toBe("partial_accept");
	await respond(request, userA.access_token, ab.id, "yes");
	expect(
		(await respond(request, userB.access_token, ab.id, "yes")).status,
	).toBe("matched");
	// 合格証拠(#23): A-Bの成立時点で、同じXを含むA-Cはcancelledで閉じる
	expect((await getLatch(request, userA.access_token, ac.id)).status).toBe(
		"cancelled",
	);
	expect((await getLatch(request, userC.access_token, ac.id)).status).toBe(
		"cancelled",
	);
	// 閉じたA-Cにはもう回答できない(状態が回答可能でない・400)
	const lateYes = await request.post(`/v1/latches/${ac.id}/response`, {
		data: { response: "yes" },
		headers: authHeaders(userA.access_token),
	});
	expect(lateYes.status()).toBe(400);
	await deleteIntent(request, userA, x.id);
	await deleteIntent(request, userB, y.id);
	await deleteIntent(request, userC, z.id);
});

test("#12(a) 成立・no後は再提案されない", async ({ request }) => {
	// 成立ペア(地域10)とnoペア(地域11)を作る
	const matchedTopic = "平日の夜にボルダリングへ行く仲間";
	const matchedPair = await proposePair(request, "再提案成立", (user) =>
		createConnection(request, user, matchedTopic, site(10)),
	);
	await respond(
		request,
		matchedPair.a.access_token,
		matchedPair.latch.id,
		"yes",
	);
	expect(
		(
			await respond(
				request,
				matchedPair.b.access_token,
				matchedPair.latch.id,
				"yes",
			)
		).status,
	).toBe("matched");
	const noTopic = "オンラインで英会話を練習する相手";
	const noPair = await proposePair(request, "再提案拒否", (user) =>
		createConnection(request, user, noTopic, site(11)),
	);
	expect(
		(await respond(request, noPair.a.access_token, noPair.latch.id, "no"))
			.status,
	).toBe("rejected");

	// 各ペアの片方が同じ主題・地域で新規Intentを再登録する
	for (const [pair, topic, area] of [
		[matchedPair, matchedTopic, site(10)],
		[noPair, noTopic, site(11)],
	] as const) {
		const again = await createConnection(request, pair.a, topic, area);
		const event = await waitForEvaluation(
			request,
			pair.a.access_token,
			again.id,
			1,
		);
		expect(isStage2Payload(event.payload), "再登録Intentの評価").toBe(true);
		const payload = event.payload as Stage2Payload;
		// 合格証拠(#12(a)): 相手のIntentは提案履歴(matched/rejected)でLayer 1除外され、
		// 評価完了後も提案が生成されない(相手側のLATCHも元の1件のまま)
		expect(payload.l1_exclusions.proposal_history).toBeGreaterThanOrEqual(1);
		expect(payload.proposed).toBe(0);
		expect(
			await listDevLatches(request, pair.a.access_token, again.id),
		).toEqual([]);
		expect(
			(await listDevLatches(request, pair.b.access_token, pair.y.id)).map(
				(l) => l.id,
			),
		).toEqual([pair.latch.id]);
		await deleteIntent(request, pair.a, again.id);
	}
	await deletePair(request, matchedPair);
	await deletePair(request, noPair);
});

test("#12(b) 見送り後の機会Intentは条件変化で再提案される", async ({
	request,
}) => {
	const startMs = Date.now() + 4 * MS_PER_HOUR;
	const pair = await proposePair(request, "再提案見送り", (user) =>
		createOccasion(
			request,
			user,
			"駅前のカフェでボードゲーム会",
			site(12),
			startMs,
		),
	);
	expect(
		(await respond(request, pair.b.access_token, pair.latch.id, "defer"))
			.status,
	).toBe("rejected");
	// 抑制期間 min(24時間, (対象時刻−見送り時刻)/2) の経過と、30分再評価抑制の解除を
	// 時計操作なしで作る(見送り時刻=2日前・最終評価=40分前)
	const nowMs = Date.now();
	await backdate(request, pair.a.access_token, pair.latch.id, {
		history_updated_at: new Date(nowMs - 2 * MS_PER_DAY).toISOString(),
		intents_last_evaluated_at: new Date(
			nowMs - 40 * MS_PER_MINUTE,
		).toISOString(),
	});
	// 条件を変える: Aの機会Intentの意味フィールド(topic)を更新する(version+1)
	const res = await request.patch(`/v1/intents/${pair.x.id}`, {
		data: { topic: "駅前のカフェで協力型ボードゲーム会" },
		headers: authHeaders(pair.a.access_token),
	});
	expect(res.status(), "PATCH /v1/intents/{id}").toBe(200);
	const patched = (await res.json()) as CreatedIntent;
	expect(patched.version).toBe(2);
	// 更新イベントは10秒遅延で配信され、再埋め込み後に再評価される(docs/06 §2)
	const event = await waitForEvaluation(
		request,
		pair.a.access_token,
		pair.x.id,
		2,
		120_000,
	);
	expect(isStage2Payload(event.payload), "更新後の再評価").toBe(true);
	// 合格証拠(#12(b)): 同じペアに新しいLATCH(別id)がproposedで生成される
	const again = await waitForLatch(
		request,
		pair.a.access_token,
		pair.x.id,
		(item) => isPairOf(pair.x, pair.y)(item) && item.id !== pair.latch.id,
	);
	expect(again.status).toBe("proposed");
	expect(
		(await getLatch(request, pair.b.access_token, pair.latch.id)).status,
	).toBe("rejected");
	const history = (await historyOf(request, pair.a)).find(
		(h) => h.user_low === pair.a.user.id || h.user_high === pair.a.user.id,
	);
	expect(history?.latch_id).toBe(again.id);
	expect(history?.outcome).toBe("proposed");
	await deletePair(request, pair);
});

/** GET /v1/intents/{id}のstatus(所有者として取得・200を保証) */
const intentStatusOf = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<string> => {
	const res = await request.get(`/v1/intents/${intentId}`, {
		headers: authHeaders(user.access_token),
	});
	expect(res.status(), `GET /v1/intents/${intentId}`).toBe(200);
	return ((await res.json()) as { status: string }).status;
};

test("#21 つながりIntentの成立後のactive復帰と再候補化", async ({
	request,
}) => {
	const topic = "週末に一緒に将棋を指せる仲間を探しています";
	const pair = await proposePair(request, "復帰", (user) =>
		createConnection(request, user, topic, site(13)),
	);
	await respond(request, pair.a.access_token, pair.latch.id, "yes");
	expect(
		(await respond(request, pair.b.access_token, pair.latch.id, "yes")).status,
	).toBe("matched");
	// 合格証拠(#21): 成立後もAのつながりIntentはactive(複数成立・docs/01 §8)
	expect(await intentStatusOf(request, pair.a, pair.x.id)).toBe("active");

	// 第三者Cが意味的に近いつながりIntentを登録する
	const c = await registerUser(request, "E2E復帰C");
	const z = await createConnection(request, c, topic, site(13));
	await waitForEvaluation(request, c.access_token, z.id, 1);
	// 合格証拠(#21): AのIntentとCのIntentの新しい提案が記録される
	const ac = await waitForLatch(
		request,
		pair.a.access_token,
		pair.x.id,
		isPairOf(pair.x, z),
	);
	expect(ac.status).toBe("proposed");
	expect(ac.id).not.toBe(pair.latch.id);
	expect(await intentStatusOf(request, pair.a, pair.x.id)).toBe("active");
	// 成立済みのA–Bは恒久排除のまま(提案履歴はmatched)
	const ab = (await historyOf(request, pair.a)).find(
		(h) => h.latch_id === pair.latch.id,
	);
	expect(ab?.outcome).toBe("matched");

	await deletePair(request, pair);
	await deleteIntent(request, c, z.id);
});
