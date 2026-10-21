/**
 * matchedのLATCHのcompleted判定(Cron (d))の統合試験(F5設計 §2・docs/02 §4の#22)。
 * 注入clock(固定時刻)で90日・対象時刻+3時間の経過を決定的に作る(docs/10 §3)。
 * 行を直接INSERTで配置する。走査は他の試験の残置行も対象にし得るため、件数は
 * 配置した行の状態で確かめる
 */
import { env } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/clock/clock";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { completeDueLatches, completeOne } from "../src/latches/complete";
import { buildProposal } from "../src/latches/content";
import type { IntentRow } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";

const workerEnv = env as unknown as WorkerEnv;
const db = drizzle(workerEnv.DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

type Form = "occasion" | "connection";

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `latches-complete-${id}`,
		actorType: "individual",
		displayName: "完了試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: ago(200 * DAY),
		updatedAt: ago(200 * DAY),
	});
	return id;
};

/** 成立済みの参加Intent(つながり=active・機会=matched)。機会はstartsAtを指定する */
const insertIntent = async (
	userId: string,
	form: Form,
	startsAt: Date | null = null,
): Promise<IntentRow> => {
	const row: IntentRow = {
		id: ulid(),
		userId,
		form,
		topic: "完了試験の主題",
		category: null,
		rawText: "完了試験用",
		startsAt,
		endsAt: startsAt === null ? null : new Date(startsAt.getTime() + 2 * HOUR),
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
		status: form === "occasion" ? "matched" : "active",
		version: 1,
		expiresAt:
			startsAt === null
				? new Date(NOW.getTime() + 30 * DAY)
				: new Date(startsAt.getTime() + 3 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: ago(200 * DAY),
		updatedAt: ago(200 * DAY),
	};
	await db.insert(intents).values(row);
	return row;
};

interface LatchOpts {
	status?: LatchStatus;
	/** つながりの最終メッセージ時刻(既定は成立時刻=1時間前) */
	lastMessageAt?: Date;
	/** 機会の参加Intentのstarts_at(人数分。提案内容のtime_window.startは最大値になる) */
	starts?: Date[];
	/** 参加人数(既定2) */
	size?: number;
	/** 離脱させる参加者の位置 */
	leftIndex?: number;
}

/** 参加Intent・LATCH・members・proposal_history(matched)を配置する */
const insertLatch = async (form: Form, opts: LatchOpts = {}) => {
	const size = opts.starts?.length ?? opts.size ?? 2;
	const members: IntentRow[] = [];
	for (let i = 0; i < size; i += 1) {
		const userId = await insertUser();
		members.push(await insertIntent(userId, form, opts.starts?.[i] ?? null));
	}
	const id = ulid();
	const proposal = buildProposal(members, null);
	await db.insert(latches).values({
		id,
		form,
		intentIds: members.map((m) => m.id),
		proposal,
		score: 0.9,
		status: opts.status ?? "matched",
		responseDeadline: ago(2 * HOUR),
		expiresAt: new Date(NOW.getTime() + DAY),
		lastMessageAt: opts.lastMessageAt ?? ago(HOUR),
		completedAt: null,
		proposedAt: ago(3 * HOUR),
		createdAt: ago(3 * HOUR),
		updatedAt: ago(HOUR),
	});
	await db.insert(latchMembers).values(
		members.map((m, i) => ({
			latchId: id,
			userId: m.userId,
			leftAt: i === opts.leftIndex ? ago(HOUR) : null,
		})),
	);
	for (let i = 0; i < members.length; i += 1) {
		for (let j = i + 1; j < members.length; j += 1) {
			const [low, high] = [members[i].userId, members[j].userId].sort();
			await db.insert(proposalHistory).values({
				id: ulid(),
				userLow: low,
				userHigh: high,
				latchId: id,
				outcome: "matched",
				createdAt: ago(3 * HOUR),
				updatedAt: ago(HOUR),
			});
		}
	}
	return { id, members, proposal };
};

const latchOf = async (id: string) => {
	const [row] = await db.select().from(latches).where(eq(latches.id, id));
	return row;
};

const eventsOf = (id: string) =>
	db.select().from(latchStatusEvents).where(eq(latchStatusEvents.latchId, id));

const statusesOf = async (ids: string[]): Promise<string[]> => {
	const out: string[] = [];
	for (let i = 0; i < ids.length; i += 50) {
		const rows = await db
			.select({ status: latches.status })
			.from(latches)
			.where(inArray(latches.id, ids.slice(i, i + 50)));
		out.push(...rows.map((r) => r.status));
	}
	return out;
};

describe("completeDueLatches(つながり・90日)", () => {
	it("90日の1ミリ秒前はmatchedのまま", async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: new Date(NOW.getTime() - 90 * DAY + 1),
		});
		await completeDueLatches(db, NOW);
		const row = await latchOf(id);
		expect(row?.status).toBe("matched");
		expect(row?.completedAt).toBeNull();
		expect(await eventsOf(id)).toHaveLength(0);
	});

	it("90日ちょうどでcompletedになり、matched→completedを記録する(#22)", async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: ago(90 * DAY),
		});
		const result = await completeDueLatches(db, NOW);
		expect(result.connection).toBeGreaterThanOrEqual(1);
		const row = await latchOf(id);
		expect(row?.status).toBe("completed");
		expect(row?.completedAt?.getTime()).toBe(NOW.getTime());
		expect(row?.updatedAt.getTime()).toBe(NOW.getTime());
		const events = await eventsOf(id);
		expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
			["matched", "completed"],
		]);
		expect(events[0]?.createdAt.getTime()).toBe(NOW.getTime());
	});

	it("2回目の実行では何も変わらない(冪等)", async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: ago(91 * DAY),
		});
		await completeDueLatches(db, NOW);
		const later = new Date(NOW.getTime() + MIN);
		await completeDueLatches(db, later);
		const row = await latchOf(id);
		expect(row?.completedAt?.getTime()).toBe(NOW.getTime());
		expect(await eventsOf(id)).toHaveLength(1);
	});

	it("離脱者がいてもLATCH全体をcompletedにする", async () => {
		const { id } = await insertLatch("connection", {
			size: 3,
			leftIndex: 0,
			lastMessageAt: ago(90 * DAY),
		});
		await completeDueLatches(db, NOW);
		expect((await latchOf(id))?.status).toBe("completed");
	});

	it("Intentの状態とproposal_historyを変えず、通知を作らない", async () => {
		const { id, members } = await insertLatch("connection", {
			lastMessageAt: ago(90 * DAY),
		});
		const occ = await insertLatch("occasion", {
			starts: [ago(3 * HOUR), ago(3 * HOUR)],
		});
		await completeDueLatches(db, NOW);
		for (const m of [...members, ...occ.members]) {
			const [row] = await db
				.select({ status: intents.status, updatedAt: intents.updatedAt })
				.from(intents)
				.where(eq(intents.id, m.id));
			expect(row?.status).toBe(m.status);
			expect(row?.updatedAt.getTime()).toBe(m.updatedAt.getTime());
		}
		for (const latchId of [id, occ.id]) {
			const history = await db
				.select()
				.from(proposalHistory)
				.where(eq(proposalHistory.latchId, latchId));
			expect(history.map((h) => h.outcome)).toEqual(["matched"]);
			expect(
				await db
					.select()
					.from(notifications)
					.where(eq(notifications.latchId, latchId)),
			).toHaveLength(0);
		}
	});
});

describe("completeDueLatches(機会・対象時刻+3時間)", () => {
	it("対象時刻+3時間の1ミリ秒前はmatchedのまま・ちょうどでcompleted", async () => {
		const before = await insertLatch("occasion", {
			starts: [new Date(NOW.getTime() - 3 * HOUR + 1), ago(4 * HOUR)],
		});
		const due = await insertLatch("occasion", {
			starts: [ago(3 * HOUR), ago(4 * HOUR)],
		});
		const result = await completeDueLatches(db, NOW);
		expect(result.occasion).toBeGreaterThanOrEqual(1);
		expect((await latchOf(before.id))?.status).toBe("matched");
		const row = await latchOf(due.id);
		expect(row?.status).toBe("completed");
		expect(row?.completedAt?.getTime()).toBe(NOW.getTime());
		expect(
			(await eventsOf(due.id)).map((e) => [e.fromStatus, e.toStatus]),
		).toEqual([["matched", "completed"]]);
	});

	it("グループは全員のstarts_atの最大値(time_window.start)で判定する", async () => {
		const group = await insertLatch("occasion", {
			starts: [ago(10 * HOUR), ago(5 * HOUR), ago(2 * HOUR)],
		});
		expect(group.proposal.time_window?.start).toBe(ago(2 * HOUR).toISOString());
		await completeDueLatches(db, NOW);
		expect((await latchOf(group.id))?.status).toBe("matched");
		await completeDueLatches(db, new Date(NOW.getTime() + HOUR));
		expect((await latchOf(group.id))?.status).toBe("completed");
	});
});

describe("completeDueLatches(対象外・上限)", () => {
	it("matched以外の状態は触らない", async () => {
		const others: LatchStatus[] = [
			"candidate",
			"proposed",
			"partial_accept",
			"rejected",
			"expired",
			"cancelled",
		];
		const placed: { id: string; updatedAt: number }[] = [];
		for (const status of others) {
			const c = await insertLatch("connection", {
				status,
				lastMessageAt: ago(200 * DAY),
			});
			const o = await insertLatch("occasion", {
				status,
				starts: [ago(DAY), ago(DAY)],
			});
			for (const id of [c.id, o.id]) {
				placed.push({
					id,
					updatedAt: (await latchOf(id))?.updatedAt.getTime() ?? 0,
				});
			}
		}
		await completeDueLatches(db, NOW);
		for (const p of placed) {
			const row = await latchOf(p.id);
			expect(row?.status).not.toBe("completed");
			expect(row?.completedAt).toBeNull();
			expect(row?.updatedAt.getTime()).toBe(p.updatedAt);
		}
	});

	it("1回の走査は合計500件までで、残りは次の走査で閉じる", async () => {
		// 他の試験の残置行より古くし、配置した行から先に処理されるようにする
		const base = ago(400 * DAY);
		const userA = await insertUser();
		const userB = await insertUser();
		const a = await insertIntent(userA, "connection");
		const b = await insertIntent(userB, "connection");
		const oa = await insertIntent(userA, "occasion", base);
		const ob = await insertIntent(userB, "occasion", base);
		const connectionIds: string[] = [];
		const occasionIds: string[] = [];
		const rows = [];
		for (let i = 0; i < 300; i += 1) {
			const cid = ulid();
			connectionIds.push(cid);
			rows.push({
				id: cid,
				form: "connection" as const,
				intentIds: [a.id, b.id],
				proposal: buildProposal([a, b], null),
				lastMessageAt: new Date(base.getTime() + i),
			});
			const oid = ulid();
			occasionIds.push(oid);
			rows.push({
				id: oid,
				form: "occasion" as const,
				intentIds: [oa.id, ob.id],
				proposal: {
					...buildProposal([oa, ob], null),
					time_window: {
						start: new Date(base.getTime() + i).toISOString(),
						end: new Date(base.getTime() + i + HOUR).toISOString(),
					},
				},
				lastMessageAt: ago(HOUR),
			});
		}
		for (let i = 0; i < rows.length; i += 5) {
			await db.insert(latches).values(
				rows.slice(i, i + 5).map((r) => ({
					...r,
					score: 0.9,
					status: "matched" as const,
					responseDeadline: base,
					expiresAt: base,
					completedAt: null,
					proposedAt: base,
					createdAt: base,
					updatedAt: base,
				})),
			);
		}
		const all = [...connectionIds, ...occasionIds];
		const countDone = async () =>
			(await statusesOf(all)).filter((s) => s === "completed").length;

		const first = await completeDueLatches(db, NOW);
		expect(first.connection + first.occasion).toBe(500);
		expect(await countDone()).toBe(500);
		expect(
			(await statusesOf(connectionIds)).every((s) => s === "completed"),
		).toBe(true);
		await completeDueLatches(db, NOW);
		expect(await countDone()).toBe(600);
	});
});

describe("completeOne(照会後の変化)", () => {
	it("照会後に先にcancelledになった行は閉じず、状態の記録も作らない", async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: ago(90 * DAY),
		});
		await db
			.update(latches)
			.set({ status: "cancelled" })
			.where(eq(latches.id, id));
		expect(await completeOne(db, id, NOW)).toBe(false);
		expect((await latchOf(id))?.status).toBe("cancelled");
		expect(await eventsOf(id)).toHaveLength(0);
	});

	it("照会後にlast_message_atが新しくなった行は閉じない", async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: ago(90 * DAY),
		});
		await db
			.update(latches)
			.set({ lastMessageAt: ago(HOUR) })
			.where(eq(latches.id, id));
		expect(await completeOne(db, id, NOW)).toBe(false);
		expect((await latchOf(id))?.status).toBe("matched");
		expect(await eventsOf(id)).toHaveLength(0);
	});
});

describe("Cronの入口", () => {
	// 同じファイルの先行試験が配置した未埋め込みのactiveなIntent(上限の試験で数百件)を、
	// runScheduledPipelineのバックフィル(06 §2)も処理するため時間がかかる。埋め込み済みにすると
	// ベクトル欠損の修復・未評価の回収が代わりに走るだけなので、全件の負荷下でも落ちない上限を置く
	it("runScheduledPipelineで90日経過のつながりLATCHがcompletedになる", {
		timeout: 15000,
	}, async () => {
		const { id } = await insertLatch("connection", {
			lastMessageAt: ago(90 * DAY),
		});
		await runScheduledPipeline(workerEnv, fixedClock(NOW));
		expect((await latchOf(id))?.status).toBe("completed");
	});
});
