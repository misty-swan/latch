/**
 * 安全のE2E(APIレベル・docs/02 §4の#26〜#30・F7aのゲート・F7a設計 §5.1)。
 * ブロックによる候補除外・通報・Intent全文の非公開・正確な位置の非公開・20歳未満の
 * 飲酒機会Intentの拒否を、wrangler devの実プロセスで確かめる。
 *
 * 配置はlatches.spec.tsと同じ(新規ユーザー・各testの前にscripts/clean-e2e-data.mjsで
 * 他specの残置Intentをexpiredへ倒す・最後に作成したIntentをDELETE)。Jevは既定stubのため
 * 同formでLayer 1を通るペアは必ず提案される。ペアをまたぐ提案を作らないよう、test
 * ごとに離れた地域(緯度0.1度ずつ・Layer 1のgeo_no_overlap)を割り当てる
 */

import { execSync } from "node:child_process";
import path from "node:path";
import type { LatchDTO } from "@latch/shared";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	type CreatedIntent,
	createIntent,
	type DevLatchItem,
	listDevLatches,
	type RegisteredUser,
	registerUser,
	respond,
	waitFor,
	waitForLatch,
} from "./helpers";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const JST_OFFSET_MS = 9 * MS_PER_HOUR;

const workerDir = path.join(import.meta.dirname, "..");

const auth = (user: RegisteredUser): Record<string, string> => ({
	authorization: `Bearer ${user.access_token}`,
});

/** docs/05 §2.2(geo)の地域添付 */
interface Geo {
	center: { lat: number; lng: number };
	radius_m: number;
}

/** testごとの地域(半径1km)。他specの地域(緯度33〜34度台)と重ならない緯度36度台に置く */
const site = (n: number): Geo => ({
	center: { lat: 36.0055 + n * 0.1, lng: 131.5055 },
	radius_m: 1_000,
});

/** GET /v1/dev/match-eventsの1項目(F3の観測契約) */
interface MatchEventItem {
	event_type: string;
	version: number;
	status: string;
	payload: unknown;
}

/** embedding_completedのpayloadのうちこのspecが読む欄(docs/06 §7) */
interface Stage2Payload {
	l1_exclusions: Record<string, number>;
	proposed: number;
}

/**
 * 指定Intentのversion 1のembedding_completedがprocessedになるまで待って返す
 * (第2段の評価=提案化までが完了し、payloadに計測が載った時点・docs/06 §7)
 */
const waitForEvaluation = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<MatchEventItem> => {
	let found: MatchEventItem | undefined;
	await waitFor(
		async () => {
			const res = await request.get(
				`/v1/dev/match-events?intent_id=${intentId}&limit=50`,
				{ headers: auth(user) },
			);
			expect(res.status(), "GET /v1/dev/match-events").toBe(200);
			const { items } = (await res.json()) as { items: MatchEventItem[] };
			found = items.find(
				(e) =>
					e.event_type === "embedding_completed" &&
					e.version === 1 &&
					e.status === "processed",
			);
			return found !== undefined;
		},
		60_000,
		500,
	);
	return found as MatchEventItem;
};

/** つながりIntentを作成する(raw_textを省くとtopicと同じ文) */
const createConnection = (
	request: APIRequestContext,
	user: RegisteredUser,
	topic: string,
	geo: Geo,
	extra: Record<string, unknown> = {},
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: topic,
		form: "connection",
		topic,
		geo,
		...extra,
	});

/** 機会Intentのリクエスト本文(starts_at=startMs・ends_at=startMs+2時間) */
const occasionBody = (
	topic: string,
	startMs: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	raw_text: topic,
	form: "occasion",
	topic,
	time: {
		start: new Date(startMs).toISOString(),
		end: new Date(startMs + 2 * MS_PER_HOUR).toISOString(),
	},
	...extra,
});

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
	latchId: string;
}

/**
 * 新規ユーザー2人にIntentを1件ずつ作り、ペアの提案(proposed=提示済み)を待って返す。
 * 作成は先の評価の完了を待ってから次を作る(検索に先の側を確実に含める)
 */
const proposePair = async (
	request: APIRequestContext,
	label: string,
	createA: (user: RegisteredUser) => Promise<CreatedIntent>,
	createB: (user: RegisteredUser) => Promise<CreatedIntent> = createA,
): Promise<Pair> => {
	const a = await registerUser(request, `E2E${label}A`);
	const x = await createA(a);
	await waitForEvaluation(request, a, x.id);
	const b = await registerUser(request, `E2E${label}B`);
	const y = await createB(b);
	await waitForEvaluation(request, b, y.id);
	const latch = await waitForLatch(
		request,
		a.access_token,
		x.id,
		isPairOf(x, y),
	);
	expect(latch.status, `${label}のペアの提案`).toBe("proposed");
	return { a, b, x, y, latchId: latch.id };
};

/** 提案を双方yesで成立させる */
const matchPair = async (
	request: APIRequestContext,
	pair: Pair,
): Promise<void> => {
	await respond(request, pair.a.access_token, pair.latchId, "yes");
	expect(
		(await respond(request, pair.b.access_token, pair.latchId, "yes")).status,
	).toBe("matched");
};

/** GET /v1/latches/{id}の生の応答(本文の文字列とJSON) */
const getLatchRaw = async (
	request: APIRequestContext,
	user: RegisteredUser,
	latchId: string,
): Promise<{ text: string; dto: LatchDTO }> => {
	const res = await request.get(`/v1/latches/${latchId}`, {
		headers: auth(user),
	});
	expect(res.status(), `GET /v1/latches/${latchId}`).toBe(200);
	const text = await res.text();
	return { text, dto: JSON.parse(text) as LatchDTO };
};

/** DELETE /v1/intents/{id}(後片付け・204を保証) */
const deleteIntent = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<void> => {
	const res = await request.delete(`/v1/intents/${intentId}`, {
		headers: auth(user),
	});
	expect(res.status(), `DELETE /v1/intents/${intentId}`).toBe(204);
};

const deletePair = async (
	request: APIRequestContext,
	pair: Pair,
): Promise<void> => {
	await deleteIntent(request, pair.a, pair.x.id);
	await deleteIntent(request, pair.b, pair.y.id);
};

/** JSON値に含まれる全てのオブジェクトのキー名(入れ子を含む) */
const keysDeep = (value: unknown): string[] => {
	if (Array.isArray(value)) {
		return value.flatMap(keysDeep);
	}
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
	}
	return [];
};

/**
 * ローカルD1へSQLを1文実行する(wrangler d1 execute --local)。起動中のwrangler devが
 * 同じD1ファイルへ書き込むためSQLITE_BUSYで失敗し得る。ロック競合だけを有界に再試行する
 * (scripts/clean-e2e-data.mjsと同じ扱い)
 */
const executeLocalD1 = async (sql: string): Promise<void> => {
	for (let attempt = 1; ; attempt++) {
		try {
			execSync(
				`wrangler d1 execute DB --local --persist-to .wrangler/e2e-state --command ${JSON.stringify(sql)}`,
				{ cwd: workerDir, stdio: "pipe" },
			);
			return;
		} catch (error) {
			const out = String((error as { stderr?: Buffer }).stderr ?? "");
			if (!/SQLITE_BUSY|database is locked/.test(out) || attempt >= 8) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
};

/** 本日(JST)からyears年前の同じ月日('YYYY-MM-DD')=今日がちょうどyears歳の誕生日 */
const birthDateYearsAgo = (years: number): string => {
	const today = new Date(Date.now() + JST_OFFSET_MS);
	const y = today.getUTCFullYear() - years;
	const m = today.getUTCMonth() + 1;
	let d = today.getUTCDate();
	// 2/29の当日に平年の生まれを求めるときは2/28へ寄せる(1日早い=満年齢は変わらない)
	if (m === 2 && d === 29 && new Date(Date.UTC(y, 1, 29)).getUTCDate() !== 29) {
		d = 28;
	}
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

// 提案の観測はキュー消費の反映を待つため既定の30秒では足りない
test.setTimeout(180_000);

test.beforeEach(() => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: workerDir,
		stdio: "ignore",
	});
});

test("#26 ブロックした相手は候補から除外され、成立中のLATCHは取り消される", async ({
	request,
}) => {
	const topic = "週末に一緒に山歩きをする仲間を探しています";
	const pair = await proposePair(request, "ブロック", (user) =>
		createConnection(request, user, topic, site(1)),
	);
	await matchPair(request, pair);

	// AがBをブロックする(新規201)
	const blockRes = await request.post(`/v1/users/${pair.b.user.id}/block`, {
		headers: auth(pair.a),
	});
	expect(blockRes.status(), "POST /v1/users/{id}/block").toBe(201);
	// 成立中の1対1はブロックで全体cancelledになり、Bからもcancelledに見える
	expect((await getLatchRaw(request, pair.b, pair.latchId)).dto.status).toBe(
		"cancelled",
	);

	// A・Bがブロック前なら一致する新しいIntent(同じ主題・同じ地域)を置く
	const x2 = await createConnection(request, pair.a, topic, site(1));
	const eventA = await waitForEvaluation(request, pair.a, x2.id);
	const y2 = await createConnection(request, pair.b, topic, site(1));
	const eventB = await waitForEvaluation(request, pair.b, y2.id);
	// 合格証拠(#26): Bの新しいIntentの評価で、Aの側のIntentはブロックでLayer 1除外される
	// (ブロックは提案履歴の恒久排除より先に判定される・docs/06 §3)
	const payloadB = eventB.payload as Stage2Payload;
	expect(payloadB.l1_exclusions.blocked).toBeGreaterThanOrEqual(1);
	expect(payloadB.proposed).toBe(0);
	const payloadA = eventA.payload as Stage2Payload;
	expect(payloadA.l1_exclusions.blocked).toBeGreaterThanOrEqual(1);
	expect(payloadA.proposed).toBe(0);
	// A-B間のLATCHは新たに作られない(元の1件のまま)
	expect(await listDevLatches(request, pair.a.access_token, x2.id)).toEqual([]);
	expect(await listDevLatches(request, pair.b.access_token, y2.id)).toEqual([]);
	expect(
		(await listDevLatches(request, pair.a.access_token, pair.x.id)).map(
			(l) => l.id,
		),
	).toEqual([pair.latchId]);

	await deleteIntent(request, pair.a, x2.id);
	await deleteIntent(request, pair.b, y2.id);
	await deletePair(request, pair);
});

/** GET /v1/dev/reportsの1項目(F7a設計 §3.3) */
interface DevReportItem {
	reportee: string;
	latch_id: string;
	target: string;
	reason: string;
	message_id: string | null;
	status: string;
}

test("#27 提案と成立後の発言を通報でき、記録が残る", async ({ request }) => {
	const pair = await proposePair(request, "通報", (user) =>
		createConnection(request, user, "朝に川沿いを走るランニング仲間", site(2)),
	);
	// 提示済みの提案を通報する(被通報者は指定しない=自分以外の参加者)
	const proposalRes = await request.post("/v1/reports", {
		data: { latch_id: pair.latchId, target: "proposal", reason: "spam" },
		headers: auth(pair.a),
	});
	expect(proposalRes.status(), "通報(proposal)").toBe(201);
	expect(await proposalRes.json()).toEqual({ received: true });

	// 成立後、Bの発言を通報する
	await matchPair(request, pair);
	const postRes = await request.post(`/v1/latches/${pair.latchId}/messages`, {
		data: { body: "通報の対象になる発言", client_id: "c-report-1" },
		headers: auth(pair.b),
	});
	expect(postRes.status()).toBe(201);
	const message = (await postRes.json()) as { id: string };
	const messageRes = await request.post("/v1/reports", {
		data: {
			latch_id: pair.latchId,
			target: "message",
			reason: "harassment",
			reportee_user_id: pair.b.user.id,
			message_id: message.id,
		},
		headers: auth(pair.a),
	});
	expect(messageRes.status(), "通報(message)").toBe(201);

	// 合格証拠(#27): 通報が2件記録される(対象・理由・LATCH・被通報者)
	const devRes = await request.get("/v1/dev/reports", {
		headers: auth(pair.a),
	});
	expect(devRes.status(), "GET /v1/dev/reports").toBe(200);
	const { reports } = (await devRes.json()) as { reports: DevReportItem[] };
	expect(reports).toHaveLength(2);
	const byTarget = Object.fromEntries(reports.map((r) => [r.target, r]));
	expect(byTarget.proposal).toMatchObject({
		reportee: pair.b.user.id,
		latch_id: pair.latchId,
		reason: "spam",
		message_id: null,
		status: "open",
	});
	expect(byTarget.message).toMatchObject({
		reportee: pair.b.user.id,
		latch_id: pair.latchId,
		reason: "harassment",
		message_id: message.id,
		status: "open",
	});
	await deletePair(request, pair);
});

test("#28 提案の相手にIntentの全文と否定条件が公開されない", async ({
	request,
}) => {
	const topic = "平日の夜に一緒に映画を観に行く仲間";
	// Aだけが本文に固有の文と否定条件を持つ
	const secretSentence =
		"実は人見知りなので最初の数回はかなり緊張すると思います";
	const negativeWord = "喫煙者";
	const pair = await proposePair(
		request,
		"全文",
		(user) =>
			createConnection(request, user, topic, site(3), {
				raw_text: `${topic}。${secretSentence}`,
				negative_constraints: [negativeWord],
			}),
		(user) => createConnection(request, user, topic, site(3)),
	);
	// Bの一覧(提案)と単一取得の応答を文字列のまま調べる
	const listRes = await request.get("/v1/latches?type=proposals", {
		headers: auth(pair.b),
	});
	expect(listRes.status(), "GET /v1/latches?type=proposals").toBe(200);
	const listText = await listRes.text();
	const listed = (JSON.parse(listText) as { items: LatchDTO[] }).items.find(
		(l) => l.id === pair.latchId,
	);
	expect(listed, "Bの提案一覧に対象の提案がある").toBeDefined();
	const single = await getLatchRaw(request, pair.b, pair.latchId);
	expect(single.dto.status).toBe("proposed");
	// 合格証拠(#28): Aのraw_textの文・否定条件の語が相手の応答に含まれず、proposal・membersも無い
	for (const text of [listText, single.text]) {
		expect(text).not.toContain(secretSentence);
		expect(text).not.toContain(negativeWord);
	}
	for (const dto of [listed, single.dto]) {
		expect(dto).not.toHaveProperty("proposal");
		expect(dto).not.toHaveProperty("members");
	}
	await deletePair(request, pair);
});

test("#29 成立後も相手に正確な位置を公開せず、地域名だけを示す", async ({
	request,
}) => {
	const geo = site(4);
	// 地名の逆引き(F4a設計 §3.6)が文字列を返すよう、Intentの中心と同じ点に地名を1件置く。
	// ローカルD1のgeofeaturesは空のため(本番は地名データを投入する)、固定idで冪等に入れる
	const gridKey = `${Math.floor(geo.center.lat * 100)}_${Math.floor(geo.center.lng * 100)}`;
	await executeLocalD1(
		`INSERT OR IGNORE INTO geofeatures (id, name, municipality, type, lat, lng, grid_key) VALUES ('01E2ESAFETYGEOFEATURE00029', 'E2E試験駅', 'E2E試験市', 'station', ${geo.center.lat}, ${geo.center.lng}, '${gridKey}')`,
	);
	const startMs = Date.now() + 4 * MS_PER_HOUR;
	const pair = await proposePair(request, "位置", (user) =>
		createIntent(
			request,
			user.access_token,
			occasionBody("駅前の広場で一緒にスケッチをしませんか", startMs, { geo }),
		),
	);
	await matchPair(request, pair);
	// 合格証拠(#29): 相手側の成立後の応答に地域名(文字列)があり、緯度経度・半径・距離のキーが無い
	for (const viewer of [pair.b, pair.a]) {
		const { text, dto } = await getLatchRaw(request, viewer, pair.latchId);
		expect(dto.status).toBe("matched");
		expect(typeof dto.proposal?.region_name).toBe("string");
		expect(dto.proposal?.region_name).toBe("E2E試験駅");
		const keys = keysDeep(JSON.parse(text));
		for (const key of ["lat", "lng", "radius_m", "distance"]) {
			expect(keys, `応答のキー${key}`).not.toContain(key);
		}
	}
	await deletePair(request, pair);
});

test("#30 20歳未満は飲酒を含む機会Intentを有効化できない", async ({
	request,
}) => {
	const startMs = Date.now() + MS_PER_DAY;
	const body = occasionBody("駅前の居酒屋で一緒に飲みませんか", startMs, {
		geo: site(5),
		alcohol_involved: true,
	});
	// 今日がちょうど19歳の誕生日=19歳(登録の18歳以上は満たす)
	const minor = await registerUser(
		request,
		"E2E飲酒19歳",
		birthDateYearsAgo(19),
	);
	const rejected = await request.post("/v1/intents", {
		data: body,
		headers: auth(minor),
	});
	// 合格証拠(#30): 19歳は422 ALCOHOL_RESTRICTED
	expect(rejected.status(), "19歳の飲酒機会Intent").toBe(422);
	const err = (await rejected.json()) as { error: { code: string } };
	expect(err.error.code).toBe("ALCOHOL_RESTRICTED");

	// 今日がちょうど20歳の誕生日=20歳は201で有効化できる
	const adult = await registerUser(
		request,
		"E2E飲酒20歳",
		birthDateYearsAgo(20),
	);
	const created = await createIntent(request, adult.access_token, body);
	expect(created.status).toBe("active");
	await deleteIntent(request, adult, created.id);
});
