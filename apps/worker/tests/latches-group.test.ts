/**
 * グループLATCH(3〜4人)の統合試験(F4b設計 §3)。行を直接INSERTで配置する。
 * - クローズのペア別履歴記録(F4b設計 §3.2・オーナー裁定1・2)
 * - 提案化(proposeSet)の全ペア確保と巻き戻し(F4b設計 §3.1・§3.6)
 */
import { env } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import {
	groupCandidates,
	intents,
	latches,
	latchMembers,
	latchResponses,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { historyBlockedPairs, proposeSet } from "../src/latches/propose";
import { respond } from "../src/latches/respond";
import type { IntentRow } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";
import { intentPairKey } from "../src/pipeline/group";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

type Form = "occasion" | "connection";

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `latches-group-${id}`,
		actorType: "individual",
		displayName: "グループ試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: ago(48 * HOUR),
		updatedAt: ago(48 * HOUR),
	});
	return id;
};

const insertIntent = async (
	userId: string,
	form: Form,
	overrides: Partial<IntentRow> = {},
): Promise<IntentRow> => {
	const occasion = form === "occasion";
	const row: IntentRow = {
		id: ulid(),
		userId,
		form,
		topic: "グループ試験の主題",
		category: null,
		rawText: "グループ試験用",
		startsAt: occasion ? later(4 * HOUR) : null,
		endsAt: occasion ? later(6 * HOUR) : null,
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
		expiresAt: occasion ? later(7 * HOUR) : later(30 * DAY),
		embeddingModel: null,
		embeddedAt: NOW,
		lastEvaluatedAt: NOW,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: ago(DAY),
		updatedAt: ago(DAY),
		...overrides,
	};
	await db.insert(intents).values(row);
	return row;
};

const pairKey = (x: string, y: string): [string, string] =>
	x < y ? [x, y] : [y, x];

interface GroupOpts {
	status?: LatchStatus;
	deadline?: Date;
	/** Y-Zの行を再提案で確保した既存行(created_atがLATCH作成より前)として配置する */
	preexistingYZ?: boolean;
}

/** 3人(X・Y・Z)のLATCH・members・proposal_history 3行(latch_idが指す)を配置する */
const setupTrio = async (form: Form, opts: GroupOpts = {}) => {
	const x = await insertUser();
	const y = await insertUser();
	const z = await insertUser();
	const ix = await insertIntent(x, form);
	const iy = await insertIntent(y, form);
	const iz = await insertIntent(z, form);
	const status = opts.status ?? "proposed";
	const latchId = ulid();
	await db.insert(latches).values({
		id: latchId,
		form,
		intentIds: [ix.id, iy.id, iz.id],
		proposal: {
			form,
			topic: ix.topic,
			time_window: null,
			region_name: null,
			participants: { min: 3, max: 4 },
			budget: null,
		},
		score: 0.9,
		status,
		responseDeadline: opts.deadline ?? later(HOUR),
		expiresAt: later(7 * HOUR),
		lastMessageAt: ago(HOUR),
		completedAt: null,
		proposedAt: ago(HOUR),
		createdAt: ago(HOUR),
		updatedAt: ago(HOUR),
	});
	await db.insert(latchMembers).values([
		{ latchId, userId: x, leftAt: null },
		{ latchId, userId: y, leftAt: null },
		{ latchId, userId: z, leftAt: null },
	]);
	for (const [p, q] of [
		[x, y],
		[x, z],
		[y, z],
	] as const) {
		const [low, high] = pairKey(p, q);
		const created =
			opts.preexistingYZ === true && p === y ? ago(2 * DAY) : ago(HOUR);
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId,
			outcome: "proposed",
			createdAt: created,
			updatedAt: ago(HOUR),
		});
	}
	return { latchId, x, y, z };
};

const insertYes = async (latchId: string, userId: string) => {
	await db.insert(latchResponses).values({
		id: ulid(),
		latchId,
		userId,
		response: "yes",
		deferReason: null,
		respondedAt: ago(MIN),
		retractedAt: null,
	});
};

const historyOf = async (p: string, q: string) => {
	const [low, high] = pairKey(p, q);
	const [row] = await db
		.select()
		.from(proposalHistory)
		.where(
			and(eq(proposalHistory.userLow, low), eq(proposalHistory.userHigh, high)),
		);
	return row;
};

const latchOf = async (id: string) => {
	const [row] = await db.select().from(latches).where(eq(latches.id, id));
	return row;
};

describe("クローズのペア別履歴記録(F4b設計 §3.2・オーナー裁定1・2)", () => {
	it("Xのdefer: Xを含む2行はdeferred・Y-Zの新規確保の行は削除する", async () => {
		const { latchId, x, y, z } = await setupTrio("occasion");
		expect(await respond(db, latchId, x, "defer", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("rejected");
		for (const other of [y, z]) {
			const row = await historyOf(x, other);
			expect(row?.outcome).toBe("deferred");
			expect(row?.updatedAt.getTime()).toBe(NOW.getTime());
		}
		expect(await historyOf(y, z)).toBeUndefined();
	});

	it("Xのdefer: Y-Zの行が再提案で確保した既存行ならexpiredへ戻す", async () => {
		const trio = await setupTrio("occasion", { preexistingYZ: true });
		expect((await respond(db, trio.latchId, trio.x, "defer", NOW)).ok).toBe(
			true,
		);
		const yz = await historyOf(trio.y, trio.z);
		expect(yz?.outcome).toBe("expired");
		expect(yz?.latchId).toBe(trio.latchId);
		expect(yz?.updatedAt.getTime()).toBe(NOW.getTime());
		expect((await historyOf(trio.x, trio.y))?.outcome).toBe("deferred");
		expect((await historyOf(trio.x, trio.z))?.outcome).toBe("deferred");
	});

	it("Xのno: Xを含む2行はrejected・Y-Zの行は削除する", async () => {
		const { latchId, x, y, z } = await setupTrio("connection");
		expect((await respond(db, latchId, x, "no", NOW)).ok).toBe(true);
		expect((await historyOf(x, y))?.outcome).toBe("rejected");
		expect((await historyOf(x, z))?.outcome).toBe("rejected");
		expect(await historyOf(y, z)).toBeUndefined();
	});

	it("Y・Zがyesのまま回答期限切れ: Xを含む2行はexpired・Y-Zの行は削除する", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});
		const { latchId, x, y, z } = await setupTrio("occasion", {
			status: "partial_accept",
			deadline: ago(MIN),
		});
		await insertYes(latchId, y);
		await insertYes(latchId, z);
		await runScheduledPipeline(testEnv, fixedClock(NOW));
		expect((await latchOf(latchId))?.status).toBe("expired");
		expect((await historyOf(x, y))?.outcome).toBe("expired");
		expect((await historyOf(x, z))?.outcome).toBe("expired");
		expect(await historyOf(y, z)).toBeUndefined();
		// yesの無効化はクローズの後に行う(既存の順)
		const yes = await db
			.select()
			.from(latchResponses)
			.where(eq(latchResponses.latchId, latchId));
		expect(yes.map((r) => r.retractedAt?.getTime())).toEqual([
			NOW.getTime(),
			NOW.getTime(),
		]);
	});

	it("誰もyesでないまま回答期限切れ: 3行ともexpired", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});
		const { latchId, x, y, z } = await setupTrio("connection", {
			deadline: ago(MIN),
		});
		// 取り消したyesは有効なyesに数えない
		await db.insert(latchResponses).values({
			id: ulid(),
			latchId,
			userId: y,
			response: "yes",
			deferReason: null,
			respondedAt: ago(10 * MIN),
			retractedAt: ago(5 * MIN),
		});
		await runScheduledPipeline(testEnv, fixedClock(NOW));
		expect((await latchOf(latchId))?.status).toBe("expired");
		for (const [p, q] of [
			[x, y],
			[x, z],
			[y, z],
		] as const) {
			const row = await historyOf(p, q);
			expect(row?.outcome).toBe("expired");
			expect(row?.updatedAt.getTime()).toBe(NOW.getTime());
		}
	});
});

/** n人(ユーザー・Intent各n件)を配置する。戻り値のIntentはid昇順 */
const insertMembers = async (
	n: number,
	form: Form,
	overrides: Partial<IntentRow> = {},
): Promise<IntentRow[]> => {
	const rows: IntentRow[] = [];
	for (let i = 0; i < n; i++) {
		rows.push(await insertIntent(await insertUser(), form, overrides));
	}
	return rows.sort((p, q) => (p.id < q.id ? -1 : 1));
};

/** group_candidates 1行を配置する(membersはid昇順) */
const insertGroupCandidate = async (
	members: IntentRow[],
	score = 0.8,
): Promise<string> => {
	const id = ulid();
	const sorted = [...members].sort((p, q) => (p.id < q.id ? -1 : 1));
	await db.insert(groupCandidates).values({
		id,
		intentIds: sorted.map((m) => m.id),
		dedupKey: sorted.map((m) => `${m.id}@${m.version}`).join(","),
		aggregateScore: score,
		prevAggregateScore: null,
		status: "candidate",
		createdAt: NOW,
	});
	return id;
};

const groupInput = (
	members: IntentRow[],
	groupCandidateId: string,
	score = 0.8,
) => ({
	members: [...members].sort((p, q) => (p.id < q.id ? -1 : 1)),
	score,
	source: { kind: "group" as const, groupCandidateId },
});

const groupCandidateOf = async (id: string) => {
	const [row] = await db
		.select()
		.from(groupCandidates)
		.where(eq(groupCandidates.id, id));
	return row;
};

/** メンバーの全ユーザーペアの履歴行(存在するものだけ) */
const historiesAmong = async (members: IntentRow[]) => {
	const out: (typeof proposalHistory.$inferSelect)[] = [];
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			const row = await historyOf(members[i].userId, members[j].userId);
			if (row !== undefined) out.push(row);
		}
	}
	return out;
};

const latchesWithAny = async (members: IntentRow[]) => {
	const ids = new Set(members.map((m) => m.id));
	const rows = await db.select().from(latches).all();
	return rows.filter((r) => r.intentIds.some((id) => ids.has(id)));
};

/** 既存の前回LATCHとproposal_history行を配置する */
const insertPrevHistory = async (
	p: IntentRow,
	q: IntentRow,
	outcome: "proposed" | "matched" | "rejected" | "deferred" | "expired",
	updatedAt: Date,
	prevScore = 0.8,
	prevCreatedAt = ago(12 * HOUR),
) => {
	const latchId = ulid();
	await db.insert(latches).values({
		id: latchId,
		form: p.form ?? "occasion",
		intentIds: [p.id, q.id].sort(),
		proposal: {},
		score: prevScore,
		status: outcome === "deferred" ? "rejected" : outcome,
		responseDeadline: later(HOUR),
		expiresAt: later(HOUR),
		lastMessageAt: prevCreatedAt,
		completedAt: null,
		proposedAt: prevCreatedAt,
		createdAt: prevCreatedAt,
		updatedAt: prevCreatedAt,
	});
	const [low, high] = pairKey(p.userId, q.userId);
	const id = ulid();
	await db.insert(proposalHistory).values({
		id,
		userLow: low,
		userHigh: high,
		latchId,
		outcome,
		createdAt: prevCreatedAt,
		updatedAt,
	});
	const [row] = await db
		.select()
		.from(proposalHistory)
		.where(eq(proposalHistory.id, id));
	return { latchId, row };
};

describe("proposeSet(集合・F4b設計 §3.1)", () => {
	it("3人: proposed・履歴3行・members 3・通知3・group_candidatesはproposed", async () => {
		const members = await insertMembers(3, "connection");
		const gid = await insertGroupCandidate(members, 0.75);
		expect(await proposeSet(db, groupInput(members, gid, 0.75), NOW)).toBe(
			"proposed",
		);
		const ls = await latchesWithAny(members);
		expect(ls).toHaveLength(1);
		const l = ls[0];
		expect(l.intentIds).toEqual(members.map((m) => m.id));
		expect(l.status).toBe("proposed");
		expect(l.score).toBe(0.75);
		const hs = await historiesAmong(members);
		expect(hs).toHaveLength(3);
		expect(
			hs.every((h) => h.latchId === l.id && h.outcome === "proposed"),
		).toBe(true);
		const ms = await db
			.select()
			.from(latchMembers)
			.where(eq(latchMembers.latchId, l.id));
		expect(ms.map((m) => m.userId).sort()).toEqual(
			members.map((m) => m.userId).sort(),
		);
		const ns = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, l.id));
		expect(ns).toHaveLength(3);
		expect(ns.every((n) => n.type === "proposal")).toBe(true);
		expect((await groupCandidateOf(gid)).status).toBe("proposed");
	});

	it("同じ3人集合の並行2回 → LATCH 1件・履歴3行", async () => {
		const members = await insertMembers(3, "connection");
		const gid = await insertGroupCandidate(members);
		const input = groupInput(members, gid);
		const outcomes = await Promise.all([
			proposeSet(db, input, NOW),
			proposeSet(db, input, NOW),
		]);
		expect([...outcomes].sort()).toEqual(["proposed", "skipped"]);
		const ls = await latchesWithAny(members);
		expect(ls).toHaveLength(1);
		const hs = await historiesAmong(members);
		expect(hs).toHaveLength(3);
		expect(hs.every((h) => h.latchId === ls[0].id)).toBe(true);
	});

	it("{A,B,C}と{A,B,D}の並行 → LATCH 1件・負けた側の確保は巻き戻す(Review Focus 1)", async () => {
		const [a, b, c, d] = await insertMembers(4, "connection");
		const abc = [a, b, c];
		const abd = [a, b, d];
		const g1 = await insertGroupCandidate(abc);
		const g2 = await insertGroupCandidate(abd);
		const outcomes = await Promise.all([
			proposeSet(db, groupInput(abc, g1), NOW),
			proposeSet(db, groupInput(abd, g2), NOW),
		]);
		expect([...outcomes].sort()).toEqual(["proposed", "skipped"]);
		const ls = await latchesWithAny([a, b, c, d]);
		expect(ls).toHaveLength(1);
		const winner = outcomes[0] === "proposed" ? abc : abd;
		const loserOnly = outcomes[0] === "proposed" ? d : c;
		const all = await historiesAmong([a, b, c, d]);
		// 勝った側のC(3,2)=3行だけが残り、すべて勝った側のLATCHを指す
		expect(all).toHaveLength(3);
		expect(all.every((h) => h.latchId === ls[0].id)).toBe(true);
		expect((await historiesAmong(winner)).length).toBe(3);
		for (const m of [a, b]) {
			expect(await historyOf(m.userId, loserOnly.userId)).toBeUndefined();
		}
		const loserGid = outcomes[0] === "proposed" ? g2 : g1;
		expect((await groupCandidateOf(loserGid)).status).toBe("candidate");
	});

	it("再提案で確保したUPDATEも、負けたときは読み出し値へ戻す", async () => {
		// A-Bにdeferred(抑制期間経過・メンバー更新あり)。{A,B,C}と{A,C,D}が並行する
		const [a, b, c, d] = await insertMembers(4, "occasion", {
			updatedAt: ago(HOUR),
		});
		const prev = await insertPrevHistory(a, b, "deferred", ago(4 * HOUR));
		const abc = [a, b, c];
		const acd = [a, c, d];
		const g1 = await insertGroupCandidate(abc);
		const g2 = await insertGroupCandidate(acd);
		const outcomes = await Promise.all([
			proposeSet(db, groupInput(abc, g1), NOW),
			proposeSet(db, groupInput(acd, g2), NOW),
		]);
		expect([...outcomes].sort()).toEqual(["proposed", "skipped"]);
		const ls = (await latchesWithAny([a, b, c, d])).filter(
			(l) => l.id !== prev.latchId,
		);
		expect(ls).toHaveLength(1);
		const ab = await historyOf(a.userId, b.userId);
		if (outcomes[0] === "proposed") {
			expect(ab?.outcome).toBe("proposed");
			expect(ab?.latchId).toBe(ls[0].id);
			expect(await historyOf(a.userId, d.userId)).toBeUndefined();
			expect(await historyOf(c.userId, d.userId)).toBeUndefined();
		} else {
			expect(ab).toEqual(prev.row);
			expect(await historyOf(b.userId, c.userId)).toBeUndefined();
		}
		const all = await historiesAmong([a, b, c, d]);
		expect(all.filter((h) => h.latchId === ls[0].id)).toHaveLength(3);
	});

	it("A-Bに進行中の1対1がある{A,B,C} → skipped・A-Bは不変・A-C/B-Cは作らない(Review Focus 2)", async () => {
		const [a, b, c] = await insertMembers(3, "connection");
		const prev = await insertPrevHistory(a, b, "proposed", ago(HOUR));
		const gid = await insertGroupCandidate([a, b, c]);
		expect(await proposeSet(db, groupInput([a, b, c], gid), NOW)).toBe(
			"skipped",
		);
		expect(await historyOf(a.userId, b.userId)).toEqual(prev.row);
		expect(await historyOf(a.userId, c.userId)).toBeUndefined();
		expect(await historyOf(b.userId, c.userId)).toBeUndefined();
		expect(await latchesWithAny([a, b, c])).toHaveLength(1);
		expect((await groupCandidateOf(gid)).status).toBe("candidate");
	});

	it("メンバー1人が当日6件の通知 → held(通知0件)", async () => {
		const members = await insertMembers(3, "connection");
		for (let i = 0; i < 6; i++) {
			await db.insert(notifications).values({
				id: ulid(),
				userId: members[1].userId,
				type: "proposal",
				latchId: null,
				readAt: null,
				createdAt: ago(HOUR),
			});
		}
		const gid = await insertGroupCandidate(members);
		expect(await proposeSet(db, groupInput(members, gid), NOW)).toBe("held");
		const ls = await latchesWithAny(members);
		expect(ls).toHaveLength(1);
		expect(ls[0].status).toBe("candidate");
		const ns = await db
			.select()
			.from(notifications)
			.where(eq(notifications.latchId, ls[0].id));
		expect(ns).toHaveLength(0);
		expect(await historiesAmong(members)).toHaveLength(3);
	});

	it("機会の3人で1ペアのみdeferred・抑制期間経過・メンバー更新あり → proposed(既存行が新idへ移る)", async () => {
		const [a, b, c] = await insertMembers(3, "occasion");
		// メンバー1人が前回LATCH作成(12時間前)より後に更新
		await db
			.update(intents)
			.set({ updatedAt: ago(HOUR) })
			.where(eq(intents.id, c.id));
		const cUpdated = { ...c, updatedAt: ago(HOUR) };
		// 見送り4時間前・対象+4時間 → 抑制=min(24時間, 8時間/2)=4時間 → ちょうど経過
		const prev = await insertPrevHistory(a, b, "deferred", ago(4 * HOUR), 0.8);
		const gid = await insertGroupCandidate([a, b, c], 0.8);
		expect(
			await proposeSet(db, groupInput([a, b, cUpdated], gid, 0.8), NOW),
		).toBe("proposed");
		const ls = (await latchesWithAny([a, b, c])).filter(
			(l) => l.id !== prev.latchId,
		);
		expect(ls).toHaveLength(1);
		const ab = await historyOf(a.userId, b.userId);
		expect(ab?.id).toBe(prev.row.id);
		expect(ab?.latchId).toBe(ls[0].id);
		expect(ab?.outcome).toBe("proposed");
		expect(ab?.updatedAt.getTime()).toBe(NOW.getTime());
		expect(await historiesAmong([a, b, c])).toHaveLength(3);
		const g = await groupCandidateOf(gid);
		expect(g.status).toBe("proposed");
		expect(g.prevAggregateScore).toBe(0.8);
	});

	it("機会でdeferredのペアがあり、score同一・メンバー未更新ならskipped", async () => {
		const [a, b, c] = await insertMembers(3, "occasion");
		await insertPrevHistory(a, b, "deferred", ago(4 * HOUR), 0.8);
		const gid = await insertGroupCandidate([a, b, c], 0.8);
		expect(await proposeSet(db, groupInput([a, b, c], gid, 0.8), NOW)).toBe(
			"skipped",
		);
		expect(await historyOf(a.userId, c.userId)).toBeUndefined();
		expect((await groupCandidateOf(gid)).prevAggregateScore).toBe(0.8);
	});
});

describe("historyBlockedPairs(F4b設計 §3.1)", () => {
	it("再提案不可・抑制期間中のペアだけを返す", async () => {
		const [a, b, c, d] = await insertMembers(4, "occasion");
		await insertPrevHistory(a, b, "rejected", ago(2 * DAY));
		await insertPrevHistory(a, c, "deferred", ago(HOUR)); // 抑制期間中
		await insertPrevHistory(b, c, "deferred", ago(4 * HOUR)); // 経過
		const blocked = await historyBlockedPairs(db, [a, b, c, d], NOW);
		expect([...blocked].sort()).toEqual(
			[intentPairKey(a.id, b.id), intentPairKey(a.id, c.id)].sort(),
		);
	});
});
