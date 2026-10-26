/**
 * Layer 1 Hard Filter(docs/06 §3)の試験。
 *
 * - layer1Judge: 表の10規則+fail-closeの純関数の単体試験。intents行を直接構築し、
 *   現在時刻は固定now(docs/04 §4の時刻の規律)を渡す
 * - fetchL1Data: D1からの評価データ一括取得の統合試験。cloudflare:testのenv.DBに
 *   drizzleで直接行をINSERTし、取得結果(候補Intent・users.birth_date・blocks両方向・
 *   proposal_history=matched/rejectedのみ)と100件チャンクの境界(101件)を検証する
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ageAtYears } from "../auth/age";
import type { intents } from "../db/schema";
import {
	blocks,
	intents as intentsTable,
	proposalHistory,
	users,
} from "../db/schema";
// ルートが受け取るEnv(src/env.ts・生成型Envの宣言部分型)
import type { Env as WorkerEnv } from "../env";
import { fetchL1Data, layer1Judge, pairKey } from "./layer1";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** 固定now(全試験で共有・docs/04 §4の時刻の規律)。JSTでは2026-06-01 09:00 */
const FIXED_NOW = new Date("2026-06-01T00:00:00Z");
const BASE = FIXED_NOW.getTime();

/** intents行の完全なフィクスチャ。指定のない欄は最小構成の値で埋める */
const intentRow = (
	overrides: Partial<typeof intents.$inferSelect> = {},
): typeof intents.$inferSelect => ({
	id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
	userId: "01JYYYYYYYYYYYYYYYYYYYYYYY",
	form: "occasion",
	topic: "学習仲間",
	category: null,
	rawText: "テスト用の入力文",
	startsAt: null,
	endsAt: null,
	geoCenterLat: null,
	geoCenterLng: null,
	geoRadiusM: null,
	participantsMin: 2,
	participantsMax: 4,
	participantsIncludesOwner: true,
	budgetMin: null,
	budgetMax: null,
	currency: null,
	hardConstraints: [],
	softConstraints: [],
	negativeConstraints: [],
	visibility: "hidden_until_match",
	notificationLevel: "proposals_only",
	alcoholInvolved: false,
	status: "active",
	version: 1,
	expiresAt: null,
	embeddingModel: null,
	embeddedAt: null,
	lastEvaluatedAt: null,
	vectorDeletedAt: null,
	delayedReevalAt: null,
	jevHeldAt: null,
	jevHeldReason: null,
	jevHeldCount: 0,
	createdAt: FIXED_NOW,
	updatedAt: FIXED_NOW,
	...overrides,
});

/** 正常系の起点Intent(機会・時間15分重まり・東京付近・予算1000〜5000円) */
const passOrigin = (
	overrides: Partial<typeof intents.$inferSelect> = {},
): typeof intents.$inferSelect =>
	intentRow({
		id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
		userId: "01JYYYYYYYYYYYYYYYYYYYYYYY",
		startsAt: new Date(BASE),
		endsAt: new Date(BASE + 2 * 60 * 60_000),
		expiresAt: new Date(BASE + 3 * 60 * 60_000),
		geoCenterLat: 35.6812,
		geoCenterLng: 139.7671,
		geoRadiusM: 500,
		budgetMin: 1000,
		budgetMax: 5000,
		currency: "JPY",
		...overrides,
	});

/**
 * 正常系の候補Intent(機会・開始が起点+1時間45分=重なりちょうど15分・
 * 同じ東京付近で中心間約181m・予算2000〜6000円)
 */
const passCandidate = (
	overrides: Partial<typeof intents.$inferSelect> = {},
): typeof intents.$inferSelect =>
	intentRow({
		id: "01JXXXXXXXXXXXXXXXXXXXXXXX",
		userId: "01JWWWWWWWWWWWWWWWWWWWWWWW",
		startsAt: new Date(BASE + 105 * 60_000),
		endsAt: new Date(BASE + 4 * 60 * 60_000),
		expiresAt: new Date(BASE + 5 * 60 * 60_000),
		geoCenterLat: 35.6812,
		geoCenterLng: 139.7691,
		geoRadiusM: 500,
		budgetMin: 2000,
		budgetMax: 6000,
		currency: "JPY",
		...overrides,
	});

/** 固定nowでの年齢を固定する誕生日フィクスチャ(19歳=2006-06-02・20歳=2006-05-31) */
describe("誕生日フィクスチャの固定(docs/05 §3.2のageAtYears)", () => {
	it("2006-06-02生まれは固定now時点で19歳・2006-05-31生まれは20歳", () => {
		expect(ageAtYears(FIXED_NOW, "2006-06-02")).toBe(19);
		expect(ageAtYears(FIXED_NOW, "2006-05-31")).toBe(20);
	});
});

describe("layer1Judge(docs/06 §3の表・上からの判定順序)", () => {
	it("正常系: form一致・時間ちょうど15分重なり・地理近接・人数・予算整合のペアはpass", () => {
		expect(
			layer1Judge(passOrigin(), passCandidate(), {}, false, false, FIXED_NOW),
		).toEqual({ pass: true });
	});

	it("form不一致(つながり×機会)はform_mismatch", () => {
		const connection = passCandidate({
			form: "connection",
			startsAt: null,
			endsAt: null,
			expiresAt: new Date(BASE + 30 * 24 * 60 * 60_000),
			geoCenterLat: null,
			geoCenterLng: null,
			geoRadiusM: null,
			budgetMin: null,
			budgetMax: null,
		});
		expect(
			layer1Judge(passOrigin(), connection, {}, false, false, FIXED_NOW),
		).toEqual({ pass: false, reason: "form_mismatch" });
	});

	it("statusがactiveでない組(候補paused・起点draft)はstatus_inactive", () => {
		expect(
			layer1Judge(
				passOrigin(),
				passCandidate({ status: "paused" }),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "status_inactive" });
		expect(
			layer1Judge(
				passOrigin({ status: "draft" }),
				passCandidate(),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "status_inactive" });
	});

	it("自己ペア(user_id一致)はself_pair", () => {
		expect(
			layer1Judge(
				passOrigin(),
				passCandidate({ userId: "01JYYYYYYYYYYYYYYYYYYYYYYY" }),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "self_pair" });
	});

	it("ブロックがある(いずれかの方向)組はblocked", () => {
		expect(
			layer1Judge(passOrigin(), passCandidate(), {}, true, false, FIXED_NOW),
		).toEqual({ pass: false, reason: "blocked" });
	});

	it("提案履歴にmatched/rejected行がある組はproposal_history(恒久排除)", () => {
		expect(
			layer1Judge(passOrigin(), passCandidate(), {}, false, true, FIXED_NOW),
		).toEqual({ pass: false, reason: "proposal_history" });
	});

	it("提案履歴がdeferredの組は恒久排除対象外でpass(hasHistory=falseで渡る)", () => {
		// deferredは条件付き再提案(機会Intentのみ)の参照に使うため、Layer 1には
		// 恒久排除として渡さない。判定側はhasHistory=falseのときpassするだけでよい
		expect(
			layer1Judge(passOrigin(), passCandidate(), {}, false, false, FIXED_NOW),
		).toEqual({ pass: true });
	});

	it("飲酒を伴う機会で片方が19歳ならalcohol_under_age", () => {
		const origin = passOrigin({ alcoholInvolved: true });
		const candidate = passCandidate({ alcoholInvolved: false });
		expect(
			layer1Judge(
				origin,
				candidate,
				{
					[origin.userId]: "2006-05-31",
					[candidate.userId]: "2006-06-02",
				},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "alcohol_under_age" });
	});

	it("飲酒を伴う機会でも両者満20歳以上ならpass", () => {
		const origin = passOrigin({ alcoholInvolved: true });
		const candidate = passCandidate({ alcoholInvolved: false });
		expect(
			layer1Judge(
				origin,
				candidate,
				{
					[origin.userId]: "2006-05-31",
					[candidate.userId]: "2000-01-01",
				},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
	});

	it("飲酒年齢のbirth_date欠落はfail-closeでalcohol_under_age", () => {
		const origin = passOrigin({ alcoholInvolved: true });
		const candidate = passCandidate();
		expect(layer1Judge(origin, candidate, {}, false, false, FIXED_NOW)).toEqual(
			{ pass: false, reason: "alcohol_under_age" },
		);
		// 起点側だけある場合も候補側の欠落でfail-close
		expect(
			layer1Judge(
				origin,
				candidate,
				{ [origin.userId]: "2006-05-31" },
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "alcohol_under_age" });
	});

	it("時間の重なりが15分未満(14分)はtime_no_overlap", () => {
		const candidate = passCandidate({
			startsAt: new Date(BASE + 106 * 60_000),
		});
		expect(
			layer1Judge(passOrigin(), candidate, {}, false, false, FIXED_NOW),
		).toEqual({ pass: false, reason: "time_no_overlap" });
	});

	it("ends_at=nullはexpires_atを終端とみなす(docs/05 §2.2)", () => {
		const origin = passOrigin({
			endsAt: null,
			expiresAt: new Date(BASE + 3 * 60 * 60_000),
		});
		const candidate = passCandidate({
			startsAt: new Date(BASE + 2 * 60 * 60_000),
			endsAt: new Date(BASE + 2 * 60 * 60_000 + 30 * 60_000),
			expiresAt: new Date(BASE + 5 * 60 * 60_000),
		});
		// 終端は min(origin.expires_at, candidate.ends_at)=+2h30m、開始は max=+2h → 30分重なり
		expect(layer1Judge(origin, candidate, {}, false, false, FIXED_NOW)).toEqual(
			{ pass: true },
		);
	});

	it("expires_atもnullで終端不能の組は時間判定をスキップする(不合格にしない)", () => {
		// 判定データを欠くNG条件は本層では扱わない(docs/06 §3)
		const origin = passOrigin({ endsAt: null, expiresAt: null });
		const candidate = passCandidate({ endsAt: null, expiresAt: null });
		expect(layer1Judge(origin, candidate, {}, false, false, FIXED_NOW)).toEqual(
			{ pass: true },
		);
	});

	it("地理が離れている(東京vs大阪・約403km)はgeo_no_overlap", () => {
		const candidate = passCandidate({
			geoCenterLat: 34.702,
			geoCenterLng: 135.4956,
		});
		expect(
			layer1Judge(passOrigin(), candidate, {}, false, false, FIXED_NOW),
		).toEqual({ pass: false, reason: "geo_no_overlap" });
	});

	it("地理は両方添付時のみ判定する(片方のみ・双方未添付は不合格にしない)", () => {
		// 片方のみ添付
		expect(
			layer1Judge(
				passOrigin(),
				passCandidate({
					geoCenterLat: null,
					geoCenterLng: null,
					geoRadiusM: null,
				}),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
		// 双方未添付(全国スコープ・docs/01 §12)
		expect(
			layer1Judge(
				passOrigin({
					geoCenterLat: null,
					geoCenterLng: null,
					geoRadiusM: null,
				}),
				passCandidate({
					geoCenterLat: null,
					geoCenterLng: null,
					geoRadiusM: null,
				}),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
	});

	it("赤道上の経度1度は約111,195m(ハバーシンの数値検証・半径和の境界)", () => {
		// 111,200m ≥ 111,194.9m → 重なりあり
		const near = passCandidate({
			geoCenterLat: 0,
			geoCenterLng: 1,
			geoRadiusM: 55_600,
		});
		expect(
			layer1Judge(
				passOrigin({ geoCenterLat: 0, geoCenterLng: 0, geoRadiusM: 55_600 }),
				near,
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
		// 110,000m < 111,194.9m → 重なりなし
		const far = passCandidate({
			geoCenterLat: 0,
			geoCenterLng: 1,
			geoRadiusM: 55_000,
		});
		expect(
			layer1Judge(
				passOrigin({ geoCenterLat: 0, geoCenterLng: 0, geoRadiusM: 55_000 }),
				far,
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "geo_no_overlap" });
	});

	it("participants区間に共通部分がない(2-3 vs 4-4)はparticipants_no_overlap", () => {
		const candidate = passCandidate({
			participantsMin: 4,
			participantsMax: 4,
		});
		expect(
			layer1Judge(
				passOrigin({ participantsMin: 2, participantsMax: 3 }),
				candidate,
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "participants_no_overlap" });
	});

	it("予算区間に共通部分がない(機会・両方設定)はbudget_no_overlap", () => {
		const candidate = passCandidate({
			budgetMin: 3000,
			budgetMax: 4000,
		});
		expect(
			layer1Judge(
				passOrigin({ budgetMin: 1000, budgetMax: 2000 }),
				candidate,
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "budget_no_overlap" });
		// 境界: 区間の端点が接する(〜3000と3000〜)は共通部分ありでpass
		expect(
			layer1Judge(
				passOrigin({ budgetMin: 1000, budgetMax: 3000 }),
				passCandidate({ budgetMin: 3000, budgetMax: 4000 }),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
	});

	it("予算は機会かつ両方設定時のみ判定する(片方のみ・つながりは不合格にしない)", () => {
		// 機会で片方のみ設定
		expect(
			layer1Judge(
				passOrigin({ budgetMin: 1000, budgetMax: 5000 }),
				passCandidate({ budgetMin: null, budgetMax: null }),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
		// つながり同士は予算不一致でも判定しない(機会のみの規則)
		const connectionBudget = {
			budgetMin: 1000,
			budgetMax: 2000,
			currency: "JPY",
		};
		expect(
			layer1Judge(
				intentRow({
					form: "connection",
					startsAt: null,
					endsAt: null,
					expiresAt: new Date(BASE + 30 * 24 * 60 * 60_000),
					...connectionBudget,
				}),
				intentRow({
					form: "connection",
					id: "01JXXXXXXXXXXXXXXXXXXXXXXX",
					userId: "01JWWWWWWWWWWWWWWWWWWWWWWW",
					startsAt: null,
					endsAt: null,
					expiresAt: new Date(BASE + 30 * 24 * 60 * 60_000),
					budgetMin: 3000,
					budgetMax: 4000,
					currency: "JPY",
				}),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: true });
	});

	it("候補のD1行が存在しない(null)はfail-closeでmissing_intent_row", () => {
		expect(
			layer1Judge(passOrigin(), null, {}, false, false, FIXED_NOW),
		).toEqual({ pass: false, reason: "missing_intent_row" });
	});

	it("判定は表の順序で最初に一致した不合格理由を1つだけ返す", () => {
		// form不一致+候補paused → より前のform_mismatch
		expect(
			layer1Judge(
				passOrigin(),
				passCandidate({ form: "connection", status: "paused" }),
				{},
				false,
				false,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "form_mismatch" });
		// 候補paused+ブロックあり → blockedより前のstatus_inactive
		expect(
			layer1Judge(
				passOrigin(),
				passCandidate({ status: "paused" }),
				{},
				true,
				true,
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "status_inactive" });
	});
});

describe("fetchL1Data(docs/06 §3・100件チャンクのD1一括取得)", () => {
	/** users行の定義(INSERT準備用) */
	const mkUser = (
		birthDate = "1990-01-01",
	): { id: string; birthDate: string } => ({
		id: ulid(),
		birthDate,
	});

	/** users行を直接INSERTする(D1のバインド上限100変数対策で8件ずつ) */
	const insertUsers = async (
		defs: { id: string; birthDate: string }[],
	): Promise<void> => {
		for (let i = 0; i < defs.length; i += 8) {
			await db.insert(users).values(
				defs.slice(i, i + 8).map((d) => ({
					id: d.id,
					authProvider: "google" as const,
					authSubject: `l1-${d.id}`,
					actorType: "individual" as const,
					displayName: "L1テスト",
					bio: "",
					birthDate: d.birthDate,
					status: "active" as const,
					createdAt: FIXED_NOW,
					updatedAt: FIXED_NOW,
				})),
			);
		}
	};

	/** 機会Intent行を直接INSERTする(1行33バインドのためD1の上限対策で2件ずつ) */
	const insertOccasionIntents = async (
		defs: { id: string; userId: string }[],
	): Promise<void> => {
		// timestamp_ms列はDateで渡す(数値のまま渡すとmapToDriverValueが失敗する)
		const rows = defs.map((d) =>
			intentRow({
				id: d.id,
				userId: d.userId,
				startsAt: new Date(BASE),
				endsAt: new Date(BASE + 2 * 60 * 60_000),
				expiresAt: new Date(BASE + 3 * 60 * 60_000),
			}),
		);
		for (let i = 0; i < rows.length; i += 2) {
			await db.insert(intentsTable).values(rows.slice(i, i + 2));
		}
	};

	/** 起点側の判定用Intent行(INSERTしない・layer1Judgeへ渡すだけ) */
	const originJudgeRow = (userId: string): typeof intents.$inferSelect =>
		intentRow({
			id: ulid(),
			userId,
			startsAt: new Date(BASE),
			endsAt: new Date(BASE + 2 * 60 * 60_000),
			expiresAt: new Date(BASE + 3 * 60 * 60_000),
		});

	it("候補Intent行・users.birth_date(起点含む)を取得し、不在候補はキーごと欠落する", async () => {
		const origin = mkUser();
		const candA = mkUser("1995-03-03");
		const candB = mkUser("2000-07-07");
		const intentA = ulid();
		const intentB = ulid();
		const missingId = ulid();
		await insertUsers([origin, candA, candB]);
		await insertOccasionIntents([
			{ id: intentA, userId: candA.id },
			{ id: intentB, userId: candB.id },
		]);

		const data = await fetchL1Data(db, origin.id, [
			intentA,
			intentB,
			missingId,
		]);

		expect(Object.keys(data.intents).sort()).toEqual([intentA, intentB].sort());
		expect(data.intents[intentA]?.userId).toBe(candA.id);
		expect(data.birthDates).toEqual({
			[origin.id]: "1990-01-01",
			[candA.id]: "1995-03-03",
			[candB.id]: "2000-07-07",
		});
		expect(data.blockedPairs.size).toBe(0);
		expect(data.historyPairs.size).toBe(0);
	});

	it("候補IDが空でも起点のbirth_dateだけ取得して空の結果を返す", async () => {
		const origin = mkUser();
		await insertUsers([origin]);

		const data = await fetchL1Data(db, origin.id, []);

		expect(data).toEqual({
			intents: {},
			birthDates: { [origin.id]: "1990-01-01" },
			blockedPairs: new Set(),
			historyPairs: new Set(),
		});
	});

	it("blocksは両方向の行を正規化キーで検出する(無関係のペアは載せない)", async () => {
		const origin = mkUser();
		const cand = mkUser();
		const other = mkUser();
		const intentId = ulid();
		await insertUsers([origin, cand, other]);
		await insertOccasionIntents([{ id: intentId, userId: cand.id }]);
		await db.insert(blocks).values([
			{
				blockerUserId: origin.id,
				blockedUserId: cand.id,
				createdAt: FIXED_NOW,
			},
			{
				blockerUserId: cand.id,
				blockedUserId: origin.id,
				createdAt: FIXED_NOW,
			},
			{
				blockerUserId: cand.id,
				blockedUserId: other.id,
				createdAt: FIXED_NOW,
			},
		]);

		const data = await fetchL1Data(db, origin.id, [intentId]);

		// 両方向INSERTでも正規化キーの1件にまとまる・起点を含まない組は載らない
		expect([...data.blockedPairs]).toEqual([pairKey(origin.id, cand.id)]);

		// 取得結果とlayer1Judgeの連結(方向の解決は正規化キーの有無で行う)
		const judgement = layer1Judge(
			originJudgeRow(origin.id),
			data.intents[intentId] ?? null,
			data.birthDates,
			data.blockedPairs.has(pairKey(origin.id, cand.id)),
			false,
			FIXED_NOW,
		);
		expect(judgement).toEqual({ pass: false, reason: "blocked" });
	});

	it("proposal_historyはmatched/rejectedのみ検出する(deferred・起点不介入は対象外)", async () => {
		const origin = mkUser();
		const matched = mkUser();
		const deferred = mkUser();
		const others = mkUser();
		const iMatched = ulid();
		const iDeferred = ulid();
		await insertUsers([origin, matched, deferred, others]);
		await insertOccasionIntents([
			{ id: iMatched, userId: matched.id },
			{ id: iDeferred, userId: deferred.id },
		]);
		const [low1, high1] = pairKey(origin.id, matched.id).split(":");
		const [low2, high2] = pairKey(origin.id, deferred.id).split(":");
		const [low3, high3] = pairKey(matched.id, others.id).split(":");
		await db.insert(proposalHistory).values([
			{
				id: ulid(),
				userLow: low1,
				userHigh: high1,
				latchId: null,
				outcome: "matched",
				createdAt: FIXED_NOW,
				updatedAt: FIXED_NOW,
			},
			{
				id: ulid(),
				userLow: low2,
				userHigh: high2,
				latchId: null,
				outcome: "deferred",
				createdAt: FIXED_NOW,
				updatedAt: FIXED_NOW,
			},
			{
				id: ulid(),
				userLow: low3,
				userHigh: high3,
				latchId: null,
				outcome: "rejected",
				createdAt: FIXED_NOW,
				updatedAt: FIXED_NOW,
			},
		]);

		const data = await fetchL1Data(db, origin.id, [iMatched, iDeferred]);

		// deferredと起点を含まないrejectedは恒久排除として載らない
		expect([...data.historyPairs]).toEqual([pairKey(origin.id, matched.id)]);

		// deferredのペアはhasHistory=falseで渡りpassする
		const originIntent = originJudgeRow(origin.id);
		expect(
			layer1Judge(
				originIntent,
				data.intents[iDeferred] ?? null,
				data.birthDates,
				false,
				data.historyPairs.has(pairKey(origin.id, deferred.id)),
				FIXED_NOW,
			),
		).toEqual({ pass: true });
		expect(
			layer1Judge(
				originIntent,
				data.intents[iMatched] ?? null,
				data.birthDates,
				false,
				data.historyPairs.has(pairKey(origin.id, matched.id)),
				FIXED_NOW,
			),
		).toEqual({ pass: false, reason: "proposal_history" });
	});

	it("101件(チャンク境界超え)でも全件取得でき、第2チャンクのblocks・第1チャンクのhistoryも検出する", async () => {
		const origin = mkUser();
		const cands = Array.from({ length: 101 }, () => mkUser());
		await insertUsers([origin, ...cands]);
		const defs = cands.map((c) => ({ id: ulid(), userId: c.id }));
		await insertOccasionIntents(defs);
		// 第2チャンク(101件目・index 100)のblocks・第1チャンク(1件目)のhistory
		await db.insert(blocks).values({
			blockerUserId: origin.id,
			blockedUserId: cands[100].id,
			createdAt: FIXED_NOW,
		});
		const [low, high] = pairKey(origin.id, cands[0].id).split(":");
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: null,
			outcome: "rejected",
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW,
		});

		const data = await fetchL1Data(
			db,
			origin.id,
			defs.map((d) => d.id),
		);

		expect(Object.keys(data.intents)).toHaveLength(101);
		expect(Object.keys(data.birthDates)).toHaveLength(102);
		expect(data.blockedPairs.has(pairKey(origin.id, cands[100].id))).toBe(true);
		expect(data.historyPairs.has(pairKey(origin.id, cands[0].id))).toBe(true);
	});
});
