/**
 * グループLATCH(3〜4人)の統合試験(F4b設計 §3)。行を直接INSERTで配置する。
 * - クローズのペア別履歴記録(F4b設計 §3.2・オーナー裁定1・2)
 */
import { env } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { respond } from "../src/latches/respond";
import type { IntentRow } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";

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

const insertIntent = async (userId: string, form: Form): Promise<IntentRow> => {
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
