/**
 * Analytics諸量の集計(02 §4 #35・docs/09 §2)の試験。行を直接INSERTで配置し、
 * src/analytics/report.tsのSQLを本物のD1(miniflare)で実行して集計の値を確かめる。
 * 期間は2031-03-01〜2031-03-02(日本時間)で、期間外の行を混ぜて絞り込みも確かめる。
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type AnalyticsQueryName,
	type AnalyticsRange,
	type AnalyticsRows,
	buildAnalyticsQueries,
	defaultRange,
	renderAnalyticsReport,
	summarizeAnalytics,
} from "../src/analytics/report";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	matchCandidates,
	matchEvents,
	messages,
	usageCounters,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import type { IntentRow } from "../src/pipeline/consumer";

const d1 = (env as unknown as WorkerEnv).DB;
const db = drizzle(d1);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2031-03-{day}の{hour}時(日本時間) */
const at = (day: number, hour: number): Date =>
	new Date(
		Date.parse(
			`2031-03-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+09:00`,
		),
	);

const D1_10 = at(1, 10);
/** 1日10時の成立から7日と1時間後(1日の成立は判定でき、2日20時の成立は判定待ち) */
const NOW = D1_10.getTime() + 7 * DAY + HOUR;
const RANGE: AnalyticsRange = {
	from: "2031-03-01",
	to: "2031-03-02",
	nowMs: NOW,
};

type Form = "connection" | "occasion";

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `analytics-${id}`,
		actorType: "individual",
		displayName: "集計試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: at(1, 0),
		updatedAt: at(1, 0),
	});
	return id;
};

const insertIntent = async (userId: string, form: Form): Promise<string> => {
	const occasion = form === "occasion";
	const row: IntentRow = {
		id: ulid(),
		userId,
		form,
		topic: "集計試験の主題",
		category: null,
		rawText: "集計試験用",
		startsAt: occasion ? at(5, 12) : null,
		endsAt: occasion ? at(5, 14) : null,
		geoCenterLat: null,
		geoCenterLng: null,
		geoRadiusM: null,
		participantsMin: 2,
		participantsMax: 3,
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
		expiresAt: at(30, 0),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: at(1, 0),
		updatedAt: at(1, 0),
	};
	await db.insert(intents).values(row);
	return row.id;
};

const insertEvent = async (
	eventType: string,
	intentId: string,
	payload: Record<string, unknown>,
	processedAt: Date,
	status: "processed" | "pending" = "processed",
): Promise<void> => {
	await db.insert(matchEvents).values({
		id: ulid(),
		eventType: eventType as typeof matchEvents.$inferInsert.eventType,
		sourceIntentId: intentId,
		version: 1,
		payload,
		status,
		createdAt: processedAt,
		processedAt,
	});
};

interface LatchSeed {
	form: Form;
	intentIds: string[];
	members: string[];
	score: number;
	status: typeof latches.$inferInsert.status;
	createdAt: Date;
	proposedAt: Date | null;
	matchedAt?: Date;
	responses?: [string, "yes" | "no" | "defer", { retracted?: boolean }?][];
	messages?: [string, Date][];
}

const insertLatch = async (s: LatchSeed): Promise<void> => {
	const id = ulid();
	await db.insert(latches).values({
		id,
		form: s.form,
		intentIds: s.intentIds,
		proposal: {
			form: s.form,
			topic: "集計試験の主題",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		},
		score: s.score,
		status: s.status,
		responseDeadline: new Date(s.createdAt.getTime() + DAY),
		expiresAt: at(30, 0),
		lastMessageAt: s.matchedAt ?? s.createdAt,
		completedAt: null,
		proposedAt: s.proposedAt,
		createdAt: s.createdAt,
		updatedAt: s.createdAt,
	});
	await db
		.insert(latchMembers)
		.values(s.members.map((userId) => ({ latchId: id, userId })));
	await db.insert(latchStatusEvents).values({
		id: ulid(),
		latchId: id,
		fromStatus: null,
		toStatus: "candidate",
		createdAt: s.createdAt,
	});
	if (s.matchedAt) {
		await db.insert(latchStatusEvents).values({
			id: ulid(),
			latchId: id,
			fromStatus: "proposed",
			toStatus: "matched",
			createdAt: s.matchedAt,
		});
	}
	for (const [userId, response, opts] of s.responses ?? []) {
		await db.insert(latchResponses).values({
			id: ulid(),
			latchId: id,
			userId,
			response,
			deferReason: null,
			respondedAt: s.createdAt,
			retractedAt: opts?.retracted ? at(3, 0) : null,
		});
	}
	for (const [userId, createdAt] of s.messages ?? []) {
		await db.insert(messages).values({
			id: ulid(),
			latchId: id,
			userId,
			body: "こんにちは",
			clientId: ulid(),
			createdAt,
		});
	}
};

const runQueries = async (range: AnalyticsRange): Promise<AnalyticsRows> => {
	const sql = buildAnalyticsQueries(range);
	const entries = await Promise.all(
		(Object.keys(sql) as AnalyticsQueryName[]).map(async (name) => {
			const { results } = await d1.prepare(sql[name]).all();
			return [name, results as Record<string, unknown>[]] as const;
		}),
	);
	return Object.fromEntries(entries) as AnalyticsRows;
};

describe("Analytics諸量の集計(02 #35)", () => {
	beforeAll(async () => {
		const [u1, u2, u3, u4] = await Promise.all(
			[1, 2, 3, 4].map(() => insertUser()),
		);
		const c1 = await insertIntent(u1, "connection");
		const c2 = await insertIntent(u2, "connection");
		const c3 = await insertIntent(u3, "connection");
		const c4 = await insertIntent(u4, "connection");
		const o1 = await insertIntent(u1, "occasion");
		const o2 = await insertIntent(u2, "occasion");
		const o3 = await insertIntent(u3, "occasion");
		const o4 = await insertIntent(u4, "occasion");

		// 評価の記録: 評価した行は層通過件数を持つ。抑制・反映を確かめただけ・期間外・
		// 有効化の行は数えない
		await insertEvent(
			"embedding_completed",
			c1,
			{
				retrieval_count: 10,
				l1_pass: 5,
				l3_pass: 3,
				l5_over_threshold: 2,
				proposed: 1,
				held_proposals: 1,
				group_proposed: 0,
				jev_calls: 3,
				group_jev_calls: 1,
				jev_reused: 0,
			},
			at(1, 9),
		);
		await insertEvent(
			"vector_reflection",
			c1,
			{
				retrieval_count: 4,
				l1_pass: 2,
				l3_pass: 1,
				l5_over_threshold: 0,
				proposed: 0,
				held_proposals: 0,
				group_proposed: 0,
				jev_calls: 1,
				group_jev_calls: 0,
				jev_reused: 1,
				reflect_ms: 2000,
			},
			at(1, 9),
		);
		await insertEvent(
			"embedding_completed",
			o1,
			{
				retrieval_count: 6,
				l1_pass: 3,
				l3_pass: 2,
				l5_over_threshold: 1,
				proposed: 1,
				held_proposals: 0,
				group_proposed: 0,
				jev_calls: 2,
				group_jev_calls: 0,
				jev_reused: 0,
			},
			at(2, 9),
		);
		await insertEvent(
			"embedding_completed",
			c2,
			{ skipped: "suppressed" },
			at(1, 9),
		);
		await insertEvent(
			"vector_reflection",
			c2,
			{ skipped: "not_evaluated", reflect_ms: 1000 },
			at(1, 9),
		);
		await insertEvent(
			"embedding_completed",
			c3,
			{ retrieval_count: 99, l1_pass: 99, l3_pass: 99 },
			at(3, 0),
		);
		await insertEvent("intent_created", c4, { retrieval_count: 99 }, at(1, 9));

		// 予算の計上(期間外の日を混ぜる)
		await db.insert(usageCounters).values([
			{ scope: "jev_global_daily", key: "-", period: "2031-03-01", count: 4 },
			{ scope: "jev_global_daily", key: "-", period: "2031-03-02", count: 3 },
			{ scope: "jev_global_daily", key: "-", period: "2031-03-03", count: 99 },
			{ scope: "jev_global_monthly", key: "-", period: "2031-03", count: 99 },
			{ scope: "jev_intent", key: c1, period: "2031-03-01", count: 3 },
			{ scope: "jev_intent", key: c1, period: "2031-03-02", count: 1 },
			{ scope: "jev_intent", key: o1, period: "2031-03-02", count: 3 },
			{ scope: "jev_intent", key: o2, period: "2031-02-28", count: 9 },
		]);

		// 評価した組(latch_scoreの無い行と期間外の行は数えない)
		const pair = (
			a: string,
			b: string,
			form: Form,
			score: number | null,
			t: Date,
		) => ({
			id: ulid(),
			intentAId: a,
			intentBId: b,
			intentAVersion: 1,
			intentBVersion: 1,
			form,
			retrievalScore: 0.8,
			cheapJudgeScore: 0.7,
			jevResult: null,
			latchScore: score,
			prevLatchScore: null,
			status: "candidate" as const,
			createdAt: t,
			updatedAt: t,
		});
		await db
			.insert(matchCandidates)
			.values([
				pair(c1, c2, "connection", 0.72, at(1, 9)),
				pair(c1, c3, "connection", 0.35, at(1, 9)),
				pair(c1, c4, "connection", null, at(1, 9)),
				pair(o1, o2, "occasion", 0.95, at(2, 9)),
				pair(c2, c3, "connection", 0.5, at(3, 9)),
			]);

		// 提案と成立
		const late = new Date(D1_10.getTime() + 8 * DAY);
		await insertLatch({
			form: "connection",
			intentIds: [c1, c2],
			members: [u1, u2],
			score: 0.72,
			status: "matched",
			createdAt: at(1, 9),
			proposedAt: at(1, 9),
			matchedAt: D1_10,
			responses: [
				[u1, "yes"],
				[u2, "yes"],
			],
			messages: [
				[u1, at(1, 12)],
				[u2, new Date(D1_10.getTime() + 6 * DAY)],
			],
		});
		// 片方が7日を過ぎてから送った成立は開始に数えない
		await insertLatch({
			form: "connection",
			intentIds: [c1, c3],
			members: [u1, u3],
			score: 0.65,
			status: "matched",
			createdAt: at(1, 9),
			proposedAt: at(1, 9),
			matchedAt: D1_10,
			responses: [
				[u1, "yes"],
				[u3, "yes"],
			],
			messages: [
				[u1, at(1, 11)],
				[u3, late],
			],
		});
		// グループ(3人全員が送った)
		await insertLatch({
			form: "connection",
			intentIds: [c1, c2, c4],
			members: [u1, u2, u4],
			score: 0.7,
			status: "matched",
			createdAt: at(1, 9),
			proposedAt: at(1, 9),
			matchedAt: D1_10,
			responses: [
				[u1, "yes"],
				[u2, "yes"],
				[u4, "yes"],
			],
			messages: [
				[u1, at(1, 11)],
				[u2, at(1, 12)],
				[u4, at(2, 12)],
			],
		});
		// 回答期限切れ(yesは無効化・もう1人は無回答)
		await insertLatch({
			form: "connection",
			intentIds: [c3, c4],
			members: [u3, u4],
			score: 0.81,
			status: "expired",
			createdAt: at(2, 9),
			proposedAt: at(2, 9),
			responses: [[u3, "yes", { retracted: true }]],
		});
		await insertLatch({
			form: "occasion",
			intentIds: [o1, o2],
			members: [u1, u2],
			score: 0.95,
			status: "rejected",
			createdAt: at(2, 9),
			proposedAt: at(2, 9),
			responses: [
				[u1, "defer"],
				[u2, "no"],
			],
		});
		// 通知上限で保留(提示していない)
		await insertLatch({
			form: "occasion",
			intentIds: [o1, o3],
			members: [u1, u3],
			score: 0.62,
			status: "candidate",
			createdAt: at(2, 9),
			proposedAt: null,
		});
		// 成立から7日たっていない(判定待ち)
		await insertLatch({
			form: "occasion",
			intentIds: [o2, o3],
			members: [u2, u3],
			score: 0.88,
			status: "matched",
			createdAt: at(2, 9),
			proposedAt: at(2, 9),
			matchedAt: at(2, 20),
			responses: [
				[u2, "yes"],
				[u3, "yes"],
			],
		});
		// 回答期間中
		await insertLatch({
			form: "occasion",
			intentIds: [o3, o4],
			members: [u3, u4],
			score: 0.75,
			status: "proposed",
			createdAt: at(2, 9),
			proposedAt: at(2, 9),
		});
		// 期間外
		await insertLatch({
			form: "connection",
			intentIds: [c2, c4],
			members: [u2, u4],
			score: 0.9,
			status: "matched",
			createdAt: at(3, 9),
			proposedAt: at(3, 9),
			matchedAt: at(3, 10),
			responses: [
				[u2, "yes"],
				[u4, "yes"],
			],
			messages: [
				[u2, at(3, 11)],
				[u4, at(3, 12)],
			],
		});
	});

	it("候補数とJevの呼び出しを評価の行から形式別に数える(抑制・反映の確認だけ・期間外の行を除く)", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.evaluations.connection).toEqual({
			evaluations: 2,
			retrieval_count: 14,
			l1_pass: 7,
			l3_pass: 4,
			l5_over_threshold: 2,
			proposed: 1,
			held_proposals: 1,
			group_proposed: 0,
			jev_calls: 4,
			group_jev_calls: 1,
			jev_reused: 1,
		});
		expect(s.evaluations.occasion.evaluations).toBe(1);
		expect(s.evaluations.occasion.l3_pass).toBe(2);
		expect(s.evaluations.total.l3_pass).toBe(6);
		expect(s.evaluations.total.jev_calls).toBe(6);
	});

	it("Jevの予算の計上を日ごとと1Intentあたりで出す", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.jev.daily).toEqual([
			{ day: "2031-03-01", count: 4 },
			{ day: "2031-03-02", count: 3 },
		]);
		expect(s.jev.total).toBe(7);
		expect(s.jev).toMatchObject({ intents: 2, perIntentCalls: 7 });
	});

	it("LATCH Scoreの分布を評価した組と提案化した組で出す", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.candidateScores.connection.n).toBe(2);
		expect(s.candidateScores.connection.buckets[3]).toBe(1);
		expect(s.candidateScores.connection.buckets[7]).toBe(1);
		expect(s.candidateScores.occasion.n).toBe(1);
		expect(s.latchScores.connection.n).toBe(4);
		expect(s.latchScores.connection.avg).toBeCloseTo(0.72, 6);
		expect(s.latchScores.connection.buckets.slice(6, 9)).toEqual([1, 2, 1]);
		// 保留(提示していない)の提案も含む
		expect(s.latchScores.occasion).toMatchObject({
			n: 4,
			min: 0.62,
			max: 0.95,
		});
		expect(s.latchScores.occasion.avg).toBeCloseTo(0.8, 6);
		expect(s.latchScores.total.n).toBe(8);
	});

	it("YES/NOを提示した提案の参加者ごとに数える(保留は数えない)", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.responses.connection).toEqual({
			seats: 9,
			yes: 8,
			yes_retracted: 1,
			no: 0,
			defer: 0,
			unanswered: 1,
		});
		expect(s.responses.occasion).toEqual({
			seats: 6,
			yes: 2,
			yes_retracted: 0,
			no: 1,
			defer: 1,
			unanswered: 2,
		});
	});

	it("Mutual Latch Rateを形式別と提示した日ごとに出す", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.mutual.connection).toEqual({ proposed: 4, matched: 3, open: 0 });
		expect(s.mutual.occasion).toEqual({ proposed: 3, matched: 1, open: 1 });
		expect(s.mutual.total).toEqual({ proposed: 7, matched: 4, open: 1 });
		expect(s.mutualDaily).toEqual([
			{
				day: "2031-03-01",
				form: "connection",
				proposed: 3,
				matched: 3,
				open: 0,
			},
			{
				day: "2031-03-02",
				form: "connection",
				proposed: 1,
				matched: 0,
				open: 0,
			},
			{ day: "2031-03-02", form: "occasion", proposed: 3, matched: 1, open: 1 },
		]);
	});

	it("チャット開始率は成立から7日以内に参加者全員が送った成立を数え、7日たっていない成立は分母に入れない", async () => {
		const s = summarizeAnalytics(await runQueries(RANGE));
		expect(s.chatStart.connection).toEqual({
			matched: 3,
			judged: 3,
			started: 2,
		});
		expect(s.chatStart.occasion).toEqual({ matched: 1, judged: 0, started: 0 });
	});

	it("表には件数と割合だけを出し、IDを出さない", async () => {
		const rows = await runQueries(RANGE);
		const text = renderAnalyticsReport(RANGE, summarizeAnalytics(rows));
		expect(text).toContain("| Mutual Latch Rate | 75.0% | 33.3% | 57.1% |");
		expect(text).toContain("| YES率 | 88.9% | 33.3% | 66.7% |");
		expect(text).toContain("| チャット開始率 | 66.7% | — | 66.7% |");
		expect(text).toContain("| 候補数(Layer 3の通過) | 4 | 2 | 6 |");
		expect(text).toContain("- 1Intentあたりの計上: 3.50回");
		// ULID(26文字の大文字英数字)が出力に混じらない
		expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
		// 問い合わせの結果の行にもIDの列が無い
		for (const list of Object.values(rows)) {
			for (const row of list) {
				expect(Object.keys(row)).not.toContain("id");
				for (const v of Object.values(row)) {
					expect(String(v)).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
				}
			}
		}
	});

	it("期間の日付を検査する", () => {
		expect(() =>
			buildAnalyticsQueries({ ...RANGE, from: "2031-3-1" }),
		).toThrow();
		expect(() =>
			buildAnalyticsQueries({ ...RANGE, from: "2031-02-30" }),
		).toThrow();
		expect(() =>
			buildAnalyticsQueries({ ...RANGE, from: "2031-03-03" }),
		).toThrow();
		expect(defaultRange(Date.parse("2031-03-30T15:00:00Z"))).toMatchObject({
			from: "2031-03-02",
			to: "2031-03-31",
		});
	});
});
