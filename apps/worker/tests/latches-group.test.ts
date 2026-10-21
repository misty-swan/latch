/**
 * グループLATCH(3〜4人)の統合試験(F4b設計 §3)。行を直接INSERTで配置する。
 * - クローズのペア別履歴記録(F4b設計 §3.2・オーナー裁定1・2)
 * - 提案化(proposeSet)の全ペア確保と巻き戻し(F4b設計 §3.1・§3.6)
 * - 成立後の離脱(leave)の個別離脱と下限割れの取り消し(F4b設計 §3.4・オーナー裁定3)
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
import { closeLatch } from "../src/latches/close";
import { proposeNextGroup } from "../src/latches/next-group";
import { historyBlockedPairs, proposeSet } from "../src/latches/propose";
import { leave, respond } from "../src/latches/respond";
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

/**
 * 最初のbatch呼び出しだけを止めるdbを返す(読み出し後・バッチ前に競合側を割り込ませる)。
 * reachedはbatchに到達したとき解決し、release()で元のbatchを実行する
 */
const gatedDb = () => {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reach = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let paused = false;
	const gated = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "batch" && !paused) {
				return async (...args: Parameters<typeof db.batch>) => {
					paused = true;
					reach();
					await released;
					return target.batch(...args);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return { db: gated, reached, release: () => release() };
};

describe("同じミリ秒・同じ遷移先の二重クローズ(F4b設計 §3.2)", () => {
	it("先に閉じた側が書いたペア行を、後から来た側の対象ペアUPDATEが上書きしない", async () => {
		const { latchId, x, y, z } = await setupTrio("connection");
		// Xのdefer側を読み出し後・バッチ前で止め、その間にYのnoが同じnow・同じtoで先に閉じる
		const gated = gatedDb();
		const loser = closeLatch(
			gated.db,
			latchId,
			"rejected",
			{ kind: "actor", userId: x, outcome: "deferred" },
			["proposed", "partial_accept"],
			NOW,
		);
		await gated.reached;
		await closeLatch(
			db,
			latchId,
			"rejected",
			{ kind: "actor", userId: y, outcome: "rejected" },
			["proposed", "partial_accept"],
			NOW,
		);
		gated.release();
		await loser;
		// 勝者(Y)の規則だけが残る: Yを含む2行はrejected・X-Zの新規確保の行は削除
		expect((await historyOf(x, y))?.outcome).toBe("rejected");
		expect((await historyOf(y, z))?.outcome).toBe("rejected");
		expect(await historyOf(x, z)).toBeUndefined();
	});
});

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

	it("{A,B,C}と{A,B,D}の競合: 読み出し後に先を越された側は確保を巻き戻す(Review Focus 1)", async () => {
		const [a, b, c, d] = await insertMembers(4, "connection");
		const abc = [a, b, c];
		const abd = [a, b, d];
		const g1 = await insertGroupCandidate(abc);
		const g2 = await insertGroupCandidate(abd);
		// {A,B,C}は履歴を読んだ後・バッチの前で止め、その間に{A,B,D}を完了させる
		const gate = gatedDb();
		const loser = proposeSet(gate.db, groupInput(abc, g1), NOW);
		await gate.reached;
		expect(await proposeSet(db, groupInput(abd, g2), NOW)).toBe("proposed");
		gate.release();
		// A-Bの確保に失敗し、新規確保したA-C・B-Cは同じバッチで削除される
		expect(await loser).toBe("skipped");
		const ls = await latchesWithAny([a, b, c, d]);
		expect(ls).toHaveLength(1);
		expect(ls[0].intentIds).toEqual(abd.map((m) => m.id));
		const all = await historiesAmong([a, b, c, d]);
		// 勝った側のC(3,2)=3行だけが残り、すべて勝った側のLATCHを指す
		expect(all).toHaveLength(3);
		expect(all.every((h) => h.latchId === ls[0].id)).toBe(true);
		expect(await historyOf(a.userId, c.userId)).toBeUndefined();
		expect(await historyOf(b.userId, c.userId)).toBeUndefined();
		expect((await groupCandidateOf(g1)).status).toBe("candidate");
		expect((await groupCandidateOf(g2)).status).toBe("proposed");
	});

	it("再提案で確保したUPDATEも、先を越されたときは読み出し値へ戻す", async () => {
		// A-Bにdeferred(抑制期間経過・メンバー更新あり)。{A,B,C}の読み出し後に{A,C,D}が先に確保する
		const [a, b, c, d] = await insertMembers(4, "occasion", {
			updatedAt: ago(HOUR),
		});
		const prev = await insertPrevHistory(a, b, "deferred", ago(4 * HOUR));
		const abc = [a, b, c];
		const acd = [a, c, d];
		const g1 = await insertGroupCandidate(abc);
		const g2 = await insertGroupCandidate(acd);
		const gate = gatedDb();
		const loser = proposeSet(gate.db, groupInput(abc, g1), NOW);
		await gate.reached;
		expect(await proposeSet(db, groupInput(acd, g2), NOW)).toBe("proposed");
		gate.release();
		// A-BのUPDATEは成功・A-Cは衝突・B-Cは新規 → 確保2/3で巻き戻す
		expect(await loser).toBe("skipped");
		const ls = (await latchesWithAny([a, b, c, d])).filter(
			(l) => l.id !== prev.latchId,
		);
		expect(ls).toHaveLength(1);
		const winnerId = ls[0].id;
		expect(ls[0].intentIds).toEqual(acd.map((m) => m.id));
		// A-Bは読み出し値(outcome・latch_id・updated_at)へ戻る
		expect(await historyOf(a.userId, b.userId)).toEqual(prev.row);
		expect(await historyOf(b.userId, c.userId)).toBeUndefined();
		// 負けた側のlatch_idを指す行は無く、勝った側の3行はそのまま
		const all = await historiesAmong([a, b, c, d]);
		expect(
			all.every((h) => h.latchId === winnerId || h.latchId === prev.latchId),
		).toBe(true);
		const won = await historiesAmong(acd);
		expect(won).toHaveLength(3);
		expect(
			won.every((h) => h.latchId === winnerId && h.outcome === "proposed"),
		).toBe(true);
		expect((await groupCandidateOf(g1)).status).toBe("candidate");
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

/** n人のmatchedのLATCH(participants.min=3)・members・proposal_history(全ペアmatched)を配置する */
const setupMatchedGroup = async (n: number) => {
	const members: string[] = [];
	const intentIds: string[] = [];
	for (let i = 0; i < n; i++) {
		const u = await insertUser();
		members.push(u);
		intentIds.push((await insertIntent(u, "connection")).id);
	}
	const latchId = ulid();
	await db.insert(latches).values({
		id: latchId,
		form: "connection",
		intentIds,
		proposal: {
			form: "connection",
			topic: "グループ試験の主題",
			time_window: null,
			region_name: null,
			participants: { min: 3, max: 4 },
			budget: null,
		},
		score: 0.9,
		status: "matched",
		responseDeadline: later(HOUR),
		expiresAt: later(30 * DAY),
		lastMessageAt: ago(HOUR),
		completedAt: null,
		proposedAt: ago(HOUR),
		createdAt: ago(HOUR),
		updatedAt: ago(HOUR),
	});
	await db
		.insert(latchMembers)
		.values(members.map((userId) => ({ latchId, userId, leftAt: null })));
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const [low, high] = pairKey(members[i] as string, members[j] as string);
			await db.insert(proposalHistory).values({
				id: ulid(),
				userLow: low,
				userHigh: high,
				latchId,
				outcome: "matched",
				createdAt: ago(HOUR),
				updatedAt: ago(HOUR),
			});
		}
	}
	return { latchId, members };
};

const leftAtOf = async (latchId: string) => {
	const rows = await db
		.select()
		.from(latchMembers)
		.where(eq(latchMembers.latchId, latchId));
	return new Map(rows.map((r) => [r.userId, r.leftAt]));
};

const closedNotificationCount = async (latchId: string) =>
	(
		await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.latchId, latchId),
					eq(notifications.type, "closed"),
				),
			)
	).length;

describe("成立後の離脱(F4b設計 §3.4・オーナー裁定3)", () => {
	it("4人(min=3)で1人leave → matchedのまま本人のleft_atだけ記録し、2人目のleaveでcancelled(closed通知なし)", async () => {
		const { latchId, members } = await setupMatchedGroup(4);
		const [a, b, c, d] = members as [string, string, string, string];
		expect(await leave(db, latchId, a, NOW)).toEqual({ ok: true, latchId });
		expect((await latchOf(latchId))?.status).toBe("matched");
		const left = await leftAtOf(latchId);
		expect(left.get(a)?.getTime()).toBe(NOW.getTime());
		expect([left.get(b), left.get(c), left.get(d)]).toEqual([null, null, null]);
		// 離脱者は非参加と同じ扱い(再度のleaveは404相当)
		expect(await leave(db, latchId, a, later(MIN))).toEqual({
			ok: false,
			reason: "not_found",
		});

		expect(await leave(db, latchId, b, later(MIN))).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		// 下限割れで取り消した離脱者もleft_atを持つ(Ruling 5・docs/05 §3.3)
		expect((await leftAtOf(latchId)).get(b)?.getTime()).toBe(
			later(MIN).getTime(),
		);
		expect(await closedNotificationCount(latchId)).toBe(0);
		// 離脱者を含む提案履歴はmatchedのまま
		expect((await historyOf(a, b))?.outcome).toBe("matched");
		expect((await historyOf(c, d))?.outcome).toBe("matched");
	});

	it("3人(min=3)で2人が並行してleave → cancelledで、matchedのままleft_atが2件ある状態にならない(Review Focus 4)", async () => {
		const { latchId, members } = await setupMatchedGroup(3);
		const [, b, c] = members as [string, string, string];
		const results = await Promise.all([
			leave(db, latchId, b, NOW),
			leave(db, latchId, c, NOW),
		]);
		expect(results.some((r) => r.ok)).toBe(true);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		// 取り消しを成功として受け取った離脱者はleft_atを持つ(Ruling 5・docs/05 §3.3)。
		// 同じnowの並行した取り消しはcloseLatchが双方に成功を返し得るため、件数は1か2になる
		const left = await leftAtOf(latchId);
		const [rb, rc] = results;
		if (rb?.ok) expect(left.get(b)).not.toBeNull();
		if (rc?.ok) expect(left.get(c)).not.toBeNull();
		const leftCount = [...left.values()].filter((v) => v !== null).length;
		expect(leftCount).toBe(results.filter((r) => r.ok).length);
		expect(await closedNotificationCount(latchId)).toBe(0);
	});

	it("4人(min=3)で同じ本人のleaveが並行2回(二重送信) → matchedのまま・left_atは1件・両方ok", async () => {
		const { latchId, members } = await setupMatchedGroup(4);
		const [a] = members as [string];
		const results = await Promise.all([
			leave(db, latchId, a, NOW),
			leave(db, latchId, a, NOW),
		]);
		expect(results).toEqual([
			{ ok: true, latchId },
			{ ok: true, latchId },
		]);
		expect((await latchOf(latchId))?.status).toBe("matched");
		const left = await leftAtOf(latchId);
		expect([...left.values()].filter((v) => v !== null)).toHaveLength(1);
		expect(left.get(a)?.getTime()).toBe(NOW.getTime());
	});

	it("4人(min=3)で2人が並行してleave → 1人だけ記録され、もう1人で下限割れとなりcancelled(Review Focus 4)", async () => {
		const { latchId, members } = await setupMatchedGroup(4);
		const [, b, c] = members as [string, string, string];
		const results = await Promise.all([
			leave(db, latchId, b, NOW),
			leave(db, latchId, c, NOW),
		]);
		expect(results).toEqual([
			{ ok: true, latchId },
			{ ok: true, latchId },
		]);
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		// 継続側の離脱者と、下限割れで取り消した離脱者の両方がleft_atを持つ(Ruling 5)
		const leftCount = [...(await leftAtOf(latchId)).values()].filter(
			(v) => v !== null,
		).length;
		expect(leftCount).toBe(2);
	});
});

describe("次集合の提案(F4b設計 §3.5)", () => {
	/** trioのIntentを{x,y,z}の順(id昇順に依らない)で返す */
	const intentsOfTrio = async (latchId: string) => {
		const l = await latchOf(latchId);
		const rows: IntentRow[] = [];
		for (const id of l?.intentIds ?? []) {
			const [r] = await db.select().from(intents).where(eq(intents.id, id));
			rows.push(r);
		}
		return rows;
	};
	const nextLatchWith = async (members: IntentRow[], exceptId: string) =>
		(await latchesWithAny(members)).filter((l) => l.id !== exceptId);

	it("Cのdeferで{A,B,C}が閉じると、評価済みの{A,B,D}が提案される", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b, c] = await intentsOfTrio(latchId);
		const [d] = await insertMembers(1, "connection");
		const abd = [a, b, d];
		const gid = await insertGroupCandidate(abd, 0.9);
		expect(await respond(db, latchId, c.userId, "defer", NOW)).toEqual({
			ok: true,
			latchId,
		});
		const next = await nextLatchWith(abd, latchId);
		expect(next.length).toBe(1);
		expect(next[0].status).toBe("proposed");
		expect(next[0].intentIds.sort()).toEqual(abd.map((m) => m.id).sort());
		expect((await groupCandidateOf(gid))?.status).toBe("proposed");
	});

	it("次集合のメンバーが更新済み(version不一致)なら提案しない", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b, c] = await intentsOfTrio(latchId);
		const [d] = await insertMembers(1, "connection");
		const gid = await insertGroupCandidate([a, b, d], 0.9);
		await db.update(intents).set({ version: 2 }).where(eq(intents.id, d.id));
		await respond(db, latchId, c.userId, "defer", NOW);
		expect((await nextLatchWith([a, b, d], latchId)).length).toBe(0);
		expect((await groupCandidateOf(gid))?.status).toBe("candidate");
	});

	it("閾値ちょうど(0.60)の集合は提案しない", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b, c] = await intentsOfTrio(latchId);
		const [d] = await insertMembers(1, "connection");
		await insertGroupCandidate([a, b, d], 0.6);
		await respond(db, latchId, c.userId, "defer", NOW);
		expect((await nextLatchWith([a, b, d], latchId)).length).toBe(0);
	});

	it("1対1(2件)のクローズ相当の呼び出しでは何もしない", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b] = await intentsOfTrio(latchId);
		const [d] = await insertMembers(1, "connection");
		await insertGroupCandidate([a, b, d], 0.9);
		expect(await proposeNextGroup(db, [a.id, b.id], NOW)).toBeNull();
		expect((await nextLatchWith([a, b, d], latchId)).length).toBe(0);
	});

	it("回答期限切れの走査で閉じた場合も次集合が提案される", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});
		const { latchId } = await setupTrio("occasion", {
			status: "partial_accept",
			deadline: ago(MIN),
		});
		const [a, b] = await intentsOfTrio(latchId);
		await insertYes(latchId, a.userId);
		await insertYes(latchId, b.userId);
		const [d] = await insertMembers(1, "occasion");
		await insertGroupCandidate([a, b, d], 0.9);
		await runScheduledPipeline(testEnv, fixedClock(NOW));
		expect((await latchOf(latchId))?.status).toBe("expired");
		const next = await nextLatchWith([a, b, d], latchId);
		expect(next.length).toBe(1);
		expect(next[0].status).toBe("proposed");
	});

	it("回答期限切れの走査では、参加者の保留の解放が次集合の提案より先に行われる", async () => {
		vi.spyOn(testEnv.MATCH_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});
		const { latchId } = await setupTrio("occasion", {
			status: "partial_accept",
			deadline: ago(MIN),
		});
		const [a, b] = await intentsOfTrio(latchId);
		await insertYes(latchId, a.userId);
		await insertYes(latchId, b.userId);
		const [d] = await insertMembers(1, "occasion");
		await insertGroupCandidate([a, b, d], 0.9);
		// Aの別Intentと相手Eの保留中の1対1(先に保留されていた提案)
		const a2 = await insertIntent(a.userId, "occasion");
		const [e] = await insertMembers(1, "occasion");
		const heldId = ulid();
		await db.insert(latches).values({
			id: heldId,
			form: "occasion",
			intentIds: [a2.id, e.id].sort(),
			proposal: {
				form: "occasion",
				topic: a2.topic,
				time_window: null,
				region_name: null,
				participants: { min: 2, max: 4 },
				budget: null,
			},
			score: 0.9,
			status: "candidate",
			responseDeadline: later(7 * HOUR),
			expiresAt: later(7 * HOUR),
			lastMessageAt: ago(HOUR),
			completedAt: null,
			proposedAt: null,
			createdAt: ago(HOUR),
			updatedAt: ago(HOUR),
		});
		await db.insert(latchMembers).values([
			{ latchId: heldId, userId: a.userId, leftAt: null },
			{ latchId: heldId, userId: e.userId, leftAt: null },
		]);
		const [low, high] = pairKey(a.userId, e.userId);
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: heldId,
			outcome: "proposed",
			createdAt: ago(HOUR),
			updatedAt: ago(HOUR),
		});
		// Aの当日の提案通知を上限の1件手前にする(提示できるのはあと1件)
		for (let i = 0; i < 5; i++) {
			await db.insert(notifications).values({
				id: ulid(),
				userId: a.userId,
				type: "proposal",
				latchId: null,
				readAt: null,
				createdAt: ago(HOUR),
			});
		}
		await runScheduledPipeline(testEnv, fixedClock(NOW));
		expect((await latchOf(latchId))?.status).toBe("expired");
		// 先に保留されていた提案が残り1枠で提示され、次集合は保留になる
		expect((await latchOf(heldId))?.status).toBe("proposed");
		const next = (await nextLatchWith([a, b, d], latchId)).filter(
			(l) => l.id !== heldId,
		);
		expect(next.length).toBe(1);
		expect(next[0].status).toBe("candidate");
	});

	it("成立後の離脱で下限割れによりcancelledになった場合も、次の集合が提案される", async () => {
		const { latchId, members } = await setupMatchedGroup(3);
		const [a] = await intentsOfTrio(latchId);
		const [d, e] = await insertMembers(2, "connection");
		await insertGroupCandidate([a, d, e], 0.9);
		const leaver = members.find((u) => u !== a.userId) as string;
		expect(await leave(db, latchId, leaver, NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		const next = await nextLatchWith([a, d, e], latchId);
		expect(next.length).toBe(1);
		expect(next[0].status).toBe("proposed");
	});

	it("閉じた集合自身のgroup_candidatesはproposedのまま再提案されない", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b, c] = await intentsOfTrio(latchId);
		const own = await insertGroupCandidate([a, b, c], 0.95);
		await db
			.update(groupCandidates)
			.set({ status: "proposed" })
			.where(eq(groupCandidates.id, own));
		await respond(db, latchId, c.userId, "defer", NOW);
		expect((await groupCandidateOf(own))?.status).toBe("proposed");
		expect((await latchesWithAny([a, b, c])).length).toBe(1);
	});

	it("最上位の集合が再検証で落ちる(メンバーがpaused) → 次の集合が提案される", async () => {
		const { latchId } = await setupTrio("connection");
		const [a, b, c] = await intentsOfTrio(latchId);
		const [d, e] = await insertMembers(2, "connection");
		await insertGroupCandidate([a, b, d], 0.95);
		const second = await insertGroupCandidate([a, b, e], 0.8);
		await db
			.update(intents)
			.set({ status: "paused" })
			.where(eq(intents.id, d.id));
		await respond(db, latchId, c.userId, "defer", NOW);
		expect((await latchesWithAny([d])).length).toBe(0);
		const next = await nextLatchWith([a, b, e], latchId);
		expect(next.length).toBe(1);
		expect((await groupCandidateOf(second))?.status).toBe("proposed");
	});

	it("機会の成立で排他取り消しになったグループ提案の後も、次の集合が提案される", async () => {
		const { latchId } = await setupTrio("occasion", {
			status: "partial_accept",
		});
		const [a, b, c] = await intentsOfTrio(latchId);
		const [d, e, f] = await insertMembers(3, "occasion");
		// 別の進行中グループ{A,D,E}(Aを共有)
		const other = ulid();
		await db.insert(latches).values({
			id: other,
			form: "occasion",
			intentIds: [a.id, d.id, e.id].sort(),
			proposal: {},
			score: 0.9,
			status: "proposed",
			responseDeadline: later(HOUR),
			expiresAt: later(7 * HOUR),
			lastMessageAt: ago(HOUR),
			completedAt: null,
			proposedAt: ago(HOUR),
			createdAt: ago(HOUR),
			updatedAt: ago(HOUR),
		});
		await db.insert(latchMembers).values(
			[a, d, e].map((m) => ({
				latchId: other,
				userId: m.userId,
				leftAt: null,
			})),
		);
		await insertGroupCandidate([d, e, f], 0.9);
		await insertYes(latchId, a.userId);
		await insertYes(latchId, b.userId);
		expect(await respond(db, latchId, c.userId, "yes", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("matched");
		expect((await latchOf(other))?.status).toBe("cancelled");
		const next = await nextLatchWith([d, e, f], other);
		expect(next.length).toBe(1);
		expect(next[0].status).toBe("proposed");
	});
});
