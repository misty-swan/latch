/**
 * 提案化(proposeSet・1対1=2人の集合)の統合試験(F4a設計 §3.2〜§3.4・§3.6)。
 * 行を直接INSERTし、履歴確保を条件とする1バッチ書き込み・並行時の1件化・
 * 再提案条件・通知上限と同時進行上限による保留・75分判定・提案直前のブロック照合を確認する。
 */
import { env } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
	blocks,
	groupCandidates,
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	matchCandidates,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { proposeSet } from "../src/latches/propose";
import type { IntentRow } from "../src/pipeline/consumer";

const db = drizzle((env as unknown as WorkerEnv).DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

const insertUser = async (id: string) => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `latches-propose-${id}`,
		actorType: "individual",
		displayName: "提案化試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: ago(48 * HOUR),
		updatedAt: ago(48 * HOUR),
	});
};

type Form = "occasion" | "connection";

const insertIntent = async (
	id: string,
	userId: string,
	form: Form,
	overrides: Partial<IntentRow> = {},
): Promise<IntentRow> => {
	const occasion = form === "occasion";
	const startsAt = occasion ? later(4 * HOUR) : null;
	const row: IntentRow = {
		id,
		userId,
		form,
		topic: "提案化試験の主題",
		category: null,
		rawText: "提案化試験用",
		startsAt,
		endsAt: occasion ? later(6 * HOUR) : null,
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
		expiresAt: occasion ? later(7 * HOUR) : later(30 * 24 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: ago(24 * HOUR),
		updatedAt: ago(24 * HOUR),
		...overrides,
	};
	await db.insert(intents).values(row);
	return row;
};

/** 2ユーザー・2Intent(a.id < b.id)・match_candidates 1行を配置する */
const setup = async (
	form: Form,
	overrides: Partial<IntentRow> = {},
	score = 0.9,
) => {
	const ua = ulid();
	const ub = ulid();
	await insertUser(ua);
	await insertUser(ub);
	const [ia, ib] = [ulid(), ulid()].sort();
	const a = await insertIntent(ia, ua, form, overrides);
	const b = await insertIntent(ib, ub, form, overrides);
	const rowId = ulid();
	await db.insert(matchCandidates).values({
		id: rowId,
		intentAId: a.id,
		intentBId: b.id,
		intentAVersion: a.version,
		intentBVersion: b.version,
		form,
		retrievalScore: 0.8,
		cheapJudgeScore: 0.8,
		jevResult: null,
		latchScore: score,
		prevLatchScore: null,
		status: "candidate",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return {
		a,
		b,
		rowId,
		input: {
			members: [a, b],
			score,
			source: { kind: "pair" as const, rowId },
		},
	};
};

const [lowOf, highOf] = [
	(x: string, y: string) => (x < y ? x : y),
	(x: string, y: string) => (x < y ? y : x),
];

/** 既存の前回LATCHとproposal_history行を配置する */
const insertHistory = async (
	a: IntentRow,
	b: IntentRow,
	outcome: "matched" | "rejected" | "deferred" | "expired",
	updatedAt: Date,
	prevScore = 0.9,
	prevCreatedAt = ago(12 * HOUR),
) => {
	const latchId = ulid();
	await db.insert(latches).values({
		id: latchId,
		form: a.form ?? "occasion",
		intentIds: [a.id, b.id],
		proposal: {},
		score: prevScore,
		status: outcome === "deferred" ? "rejected" : outcome,
		responseDeadline: prevCreatedAt,
		expiresAt: prevCreatedAt,
		lastMessageAt: prevCreatedAt,
		completedAt: null,
		proposedAt: prevCreatedAt,
		createdAt: prevCreatedAt,
		updatedAt: prevCreatedAt,
	});
	const historyId = ulid();
	await db.insert(proposalHistory).values({
		id: historyId,
		userLow: lowOf(a.userId, b.userId),
		userHigh: highOf(a.userId, b.userId),
		latchId,
		outcome,
		createdAt: prevCreatedAt,
		updatedAt,
	});
	return { latchId, historyId };
};

const latchesOf = (intentId: string) =>
	db
		.select()
		.from(latches)
		.all()
		.then((rows) => rows.filter((r) => r.intentIds.includes(intentId)));

const historyOf = async (a: IntentRow, b: IntentRow) =>
	db
		.select()
		.from(proposalHistory)
		.where(eq(proposalHistory.userLow, lowOf(a.userId, b.userId)));

const notificationsOf = (latchId: string) =>
	db.select().from(notifications).where(eq(notifications.latchId, latchId));

const candidateOf = async (rowId: string) => {
	const [row] = await db
		.select()
		.from(matchCandidates)
		.where(eq(matchCandidates.id, rowId));
	return row;
};

describe("proposeSet(1対1)", () => {
	it("(a) 新規ペアはproposed・LATCH1件・members2・通知2・履歴が新LATCHを指す", async () => {
		const { a, b, rowId, input } = await setup("occasion");
		expect(await proposeSet(db, input, NOW)).toBe("proposed");

		const ls = await latchesOf(a.id);
		expect(ls).toHaveLength(1);
		const l = ls[0];
		expect(l.intentIds).toEqual([a.id, b.id]);
		expect(l.status).toBe("proposed");
		expect(l.proposedAt).toEqual(NOW);
		expect(l.score).toBe(0.9);
		// 対象時刻=+4時間 → min(提示+2時間, 対象-60分)=+2時間
		expect(l.responseDeadline).toEqual(later(2 * HOUR));
		expect(l.expiresAt).toEqual(later(7 * HOUR));
		expect(l.lastMessageAt).toEqual(NOW);
		expect((l.proposal as { form: string }).form).toBe("occasion");

		const members = await db
			.select()
			.from(latchMembers)
			.where(eq(latchMembers.latchId, l.id));
		expect(members.map((m) => m.userId).sort()).toEqual(
			[a.userId, b.userId].sort(),
		);

		const ns = await notificationsOf(l.id);
		expect(ns).toHaveLength(2);
		expect(ns.every((n) => n.type === "proposal" && n.readAt === null)).toBe(
			true,
		);

		const events = await db
			.select()
			.from(latchStatusEvents)
			.where(eq(latchStatusEvents.latchId, l.id));
		expect(events).toHaveLength(1);
		expect(events[0].fromStatus).toBeNull();
		expect(events[0].toStatus).toBe("proposed");

		const hs = await historyOf(a, b);
		expect(hs).toHaveLength(1);
		expect(hs[0].outcome).toBe("proposed");
		expect(hs[0].latchId).toBe(l.id);
		expect(hs[0].userHigh).toBe(highOf(a.userId, b.userId));

		expect((await candidateOf(rowId)).status).toBe("proposed");
	});

	it("(b) 同じinputの並行2回でもLATCHは1件・片方はskipped", async () => {
		const { a, b, input } = await setup("connection");
		const outcomes = await Promise.all([
			proposeSet(db, input, NOW),
			proposeSet(db, input, NOW),
		]);
		expect([...outcomes].sort()).toEqual(["proposed", "skipped"]);

		const ls = await latchesOf(a.id);
		expect(ls).toHaveLength(1);
		const hs = await historyOf(a, b);
		expect(hs).toHaveLength(1);
		expect(hs[0].latchId).toBe(ls[0].id);
		const members = await db
			.select()
			.from(latchMembers)
			.where(eq(latchMembers.latchId, ls[0].id));
		expect(members).toHaveLength(2);
		expect(await notificationsOf(ls[0].id)).toHaveLength(2);
	});

	it.each(["matched", "rejected"] as const)(
		"(c) 履歴outcome=%sならskipped",
		async (outcome) => {
			const { a, b, rowId, input } = await setup("occasion");
			await insertHistory(a, b, outcome, ago(48 * HOUR));
			expect(await proposeSet(db, input, NOW)).toBe("skipped");
			expect(await latchesOf(a.id)).toHaveLength(1);
			expect((await candidateOf(rowId)).status).toBe("candidate");
		},
	);

	it("(d) つながりで履歴outcome=deferredならskipped", async () => {
		const { a, b, input } = await setup("connection");
		await insertHistory(a, b, "deferred", ago(30 * 24 * HOUR));
		expect(await proposeSet(db, input, NOW)).toBe("skipped");
		expect(await latchesOf(a.id)).toHaveLength(1);
	});

	describe("(e) 機会でdeferred後の再提案", () => {
		it("抑制期間内はskipped", async () => {
			// 見送り1時間前・対象+4時間 → 抑制=min(24時間, 5時間/2)=2.5時間
			const { a, b, rowId, input } = await setup("occasion", {}, 0.95);
			await insertHistory(a, b, "deferred", ago(1 * HOUR), 0.9);
			expect(await proposeSet(db, input, NOW)).toBe("skipped");
			expect(await latchesOf(a.id)).toHaveLength(1);
			// 前回latch.scoreを記録する
			expect((await candidateOf(rowId)).prevLatchScore).toBe(0.9);
		});

		it("経過後でもscore同一・Intent未更新ならskipped", async () => {
			// 見送り4時間前・対象+4時間 → 抑制=min(24時間, 8時間/2)=4時間 → ちょうど経過
			const { a, b, rowId, input } = await setup("occasion", {}, 0.9);
			await insertHistory(a, b, "deferred", ago(4 * HOUR), 0.9);
			expect(await proposeSet(db, input, NOW)).toBe("skipped");
			expect(await latchesOf(a.id)).toHaveLength(1);
			expect((await candidateOf(rowId)).prevLatchScore).toBe(0.9);
		});

		it("経過後かつIntent更新ならproposedで履歴を更新する", async () => {
			const { a, b, rowId, input } = await setup(
				"occasion",
				{ updatedAt: ago(1 * HOUR) },
				0.9,
			);
			const prev = await insertHistory(a, b, "deferred", ago(4 * HOUR), 0.9);
			expect(await proposeSet(db, input, NOW)).toBe("proposed");

			const ls = (await latchesOf(a.id)).filter((l) => l.id !== prev.latchId);
			expect(ls).toHaveLength(1);
			const hs = await historyOf(a, b);
			expect(hs).toHaveLength(1);
			expect(hs[0].id).toBe(prev.historyId);
			expect(hs[0].outcome).toBe("proposed");
			expect(hs[0].latchId).toBe(ls[0].id);
			expect(hs[0].updatedAt).toEqual(NOW);
			const c = await candidateOf(rowId);
			expect(c.status).toBe("proposed");
			expect(c.prevLatchScore).toBe(0.9);
		});

		it("経過後かつscore変化ならproposed(expiredも対象)", async () => {
			const { a, b, input } = await setup("occasion", {}, 0.95);
			await insertHistory(a, b, "expired", ago(4 * HOUR), 0.9);
			expect(await proposeSet(db, input, NOW)).toBe("proposed");
			expect(await latchesOf(a.id)).toHaveLength(2);
		});
	});

	it("(f) 片方ユーザーの当日proposal通知が6件ならheld", async () => {
		const { a, rowId, input } = await setup("connection");
		for (let i = 0; i < 6; i++) {
			await db.insert(notifications).values({
				id: ulid(),
				userId: a.userId,
				type: "proposal",
				latchId: null,
				readAt: null,
				createdAt: ago(1 * HOUR),
			});
		}
		expect(await proposeSet(db, input, NOW)).toBe("held");
		const ls = await latchesOf(a.id);
		expect(ls).toHaveLength(1);
		expect(ls[0].status).toBe("candidate");
		expect(ls[0].proposedAt).toBeNull();
		// 保留中の回答期限は暫定でexpires_at
		expect(ls[0].responseDeadline).toEqual(ls[0].expiresAt);
		expect(await notificationsOf(ls[0].id)).toHaveLength(0);
		const [event] = await db
			.select()
			.from(latchStatusEvents)
			.where(eq(latchStatusEvents.latchId, ls[0].id));
		expect(event.toStatus).toBe("candidate");
		expect((await candidateOf(rowId)).status).toBe("proposed");
	});

	it("前日(JST)の通知は上限に数えない", async () => {
		const { a, input } = await setup("connection");
		// NOW=JST 12:00。JSTの日の始まりより前=13時間前
		for (let i = 0; i < 6; i++) {
			await db.insert(notifications).values({
				id: ulid(),
				userId: a.userId,
				type: "proposal",
				latchId: null,
				readAt: null,
				createdAt: ago(13 * HOUR),
			});
		}
		expect(await proposeSet(db, input, NOW)).toBe("proposed");
	});

	it("(g) Intentの進行中LATCHが3件ならheld", async () => {
		const { a, input } = await setup("connection");
		for (const status of ["proposed", "partial_accept", "proposed"] as const) {
			await db.insert(latches).values({
				id: ulid(),
				form: "connection",
				intentIds: [a.id, ulid()],
				proposal: {},
				score: 0.8,
				status,
				responseDeadline: later(HOUR),
				expiresAt: later(HOUR),
				lastMessageAt: NOW,
				completedAt: null,
				proposedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		expect(await proposeSet(db, input, NOW)).toBe("held");
	});

	it("保留中(candidate)のLATCHは進行中に数えない", async () => {
		const { a, input } = await setup("connection");
		for (let i = 0; i < 3; i++) {
			await db.insert(latches).values({
				id: ulid(),
				form: "connection",
				intentIds: [ulid(), a.id],
				proposal: {},
				score: 0.8,
				status: "candidate",
				responseDeadline: later(HOUR),
				expiresAt: later(HOUR),
				lastMessageAt: NOW,
				completedAt: null,
				proposedAt: null,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		expect(await proposeSet(db, input, NOW)).toBe("proposed");
	});

	it("(h) 機会で対象時刻まで74分ならskipped", async () => {
		const { a, b, rowId, input } = await setup("occasion", {
			startsAt: later(74 * MIN),
		});
		expect(await proposeSet(db, input, NOW)).toBe("skipped");
		expect(await latchesOf(a.id)).toHaveLength(0);
		expect(await historyOf(a, b)).toHaveLength(0);
		expect((await candidateOf(rowId)).status).toBe("candidate");
	});
});

/** blocks行を配置する(blocker → blocked の1方向) */
const insertBlock = async (blocker: string, blocked: string) => {
	await db.insert(blocks).values({
		blockerUserId: blocker,
		blockedUserId: blocked,
		createdAt: ago(1 * HOUR),
	});
};

const membersOfLatches = (latchIds: string[]) =>
	latchIds.length === 0
		? Promise.resolve([])
		: db
				.select()
				.from(latchMembers)
				.where(inArray(latchMembers.latchId, latchIds));

const notificationsOfUsers = (userIds: string[]) =>
	db.select().from(notifications).where(inArray(notifications.userId, userIds));

describe("proposeSet の提案直前のブロック照合(F7a設計 §2.4)", () => {
	const directions = ["a→b", "b→a"] as const;

	it.each(directions)(
		"1対1の新規ペアで %s のブロックがあればskipped・何も作らない",
		async (dir) => {
			const { a, b, rowId, input } = await setup("connection");
			if (dir === "a→b") await insertBlock(a.userId, b.userId);
			else await insertBlock(b.userId, a.userId);

			expect(await proposeSet(db, input, NOW)).toBe("skipped");
			expect(await latchesOf(a.id)).toHaveLength(0);
			expect(await historyOf(a, b)).toHaveLength(0);
			expect(await notificationsOfUsers([a.userId, b.userId])).toHaveLength(0);
			expect((await candidateOf(rowId)).status).toBe("candidate");
		},
	);

	it.each(directions)(
		"1対1の再提案で %s のブロックがあればskipped・既存の履歴行はexpiredのまま",
		async (dir) => {
			// ブロックが無ければ再提案される条件(score変化・抑制経過)
			const { a, b, rowId, input } = await setup("occasion", {}, 0.95);
			const prev = await insertHistory(a, b, "expired", ago(4 * HOUR), 0.9);
			if (dir === "a→b") await insertBlock(a.userId, b.userId);
			else await insertBlock(b.userId, a.userId);

			expect(await proposeSet(db, input, NOW)).toBe("skipped");
			const ls = await latchesOf(a.id);
			expect(ls.map((l) => l.id)).toEqual([prev.latchId]);
			expect(await membersOfLatches([prev.latchId])).toHaveLength(0);
			expect(await notificationsOfUsers([a.userId, b.userId])).toHaveLength(0);
			const hs = await historyOf(a, b);
			expect(hs).toHaveLength(1);
			expect(hs[0].id).toBe(prev.historyId);
			expect(hs[0].outcome).toBe("expired");
			expect(hs[0].latchId).toBe(prev.latchId);
			expect(hs[0].updatedAt).toEqual(ago(4 * HOUR));
			expect((await candidateOf(rowId)).status).toBe("candidate");
		},
	);

	it.each(directions)(
		"3人集合の1ペアだけ %s のブロックがあればskipped・全ペアの確保を巻き戻す",
		async (dir) => {
			const userIds = [ulid(), ulid(), ulid()];
			for (const u of userIds) await insertUser(u);
			const intentIds = [ulid(), ulid(), ulid()].sort();
			const members: IntentRow[] = [];
			for (let i = 0; i < 3; i++) {
				members.push(
					await insertIntent(intentIds[i], userIds[i], "connection", {
						participantsMax: 3,
					}),
				);
			}
			const groupCandidateId = ulid();
			await db.insert(groupCandidates).values({
				id: groupCandidateId,
				intentIds: members.map((m) => m.id),
				dedupKey: members.map((m) => `${m.id}@${m.version}`).join(","),
				aggregateScore: 0.8,
				prevAggregateScore: null,
				status: "candidate",
				createdAt: NOW,
			});
			// 2人目と3人目のペアだけブロック(1人目は誰ともブロックしていない)
			const [p, q] =
				dir === "a→b"
					? [members[1].userId, members[2].userId]
					: [members[2].userId, members[1].userId];
			await insertBlock(p, q);

			expect(
				await proposeSet(
					db,
					{
						members,
						score: 0.8,
						source: { kind: "group", groupCandidateId },
					},
					NOW,
				),
			).toBe("skipped");
			for (const m of members) expect(await latchesOf(m.id)).toHaveLength(0);
			const hs = await db
				.select()
				.from(proposalHistory)
				.where(inArray(proposalHistory.userLow, userIds));
			expect(hs).toHaveLength(0);
			expect(await notificationsOfUsers(userIds)).toHaveLength(0);
			const [gc] = await db
				.select()
				.from(groupCandidates)
				.where(eq(groupCandidates.id, groupCandidateId));
			expect(gc.status).toBe("candidate");
		},
	);

	it("当事者以外のブロックは提案を止めない", async () => {
		const { a, b, input } = await setup("connection");
		const outsider = ulid();
		await insertUser(outsider);
		await insertBlock(a.userId, outsider);
		await insertBlock(outsider, b.userId);
		expect(await proposeSet(db, input, NOW)).toBe("proposed");
		expect(await latchesOf(a.id)).toHaveLength(1);
	});
});
