/**
 * 回答(yes/defer/no)・取り消し・離脱・見送り理由と成立後処理(機会の排他)の統合試験
 * (F4a設計 §4.2〜§4.4)。行を直接INSERTで配置する。
 */
import { env } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import {
	leave,
	respond,
	retract,
	saveDeferReason,
} from "../src/latches/respond";
import type { IntentRow } from "../src/pipeline/consumer";

const db = drizzle((env as unknown as WorkerEnv).DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

type Form = "occasion" | "connection";

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `latches-respond-${id}`,
		actorType: "individual",
		displayName: "回答試験",
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
		topic: "回答試験の主題",
		category: null,
		rawText: "回答試験用",
		startsAt: occasion ? later(4 * HOUR) : null,
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
	};
	await db.insert(intents).values(row);
	return row;
};

interface LatchOpts {
	status?: LatchStatus;
	deadline?: Date;
}

/** 2Intentの間のLATCH・members・proposal_history(latch_idが指す)を配置する */
const insertLatch = async (
	a: IntentRow,
	b: IntentRow,
	opts: LatchOpts = {},
): Promise<string> => {
	const form = a.form ?? "occasion";
	const status = opts.status ?? "proposed";
	const id = ulid();
	await db.insert(latches).values({
		id,
		form,
		intentIds: [a.id, b.id],
		proposal: {
			form,
			topic: a.topic,
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		},
		score: 0.9,
		status,
		responseDeadline: opts.deadline ?? later(HOUR),
		expiresAt: later(7 * HOUR),
		lastMessageAt: ago(HOUR),
		completedAt: null,
		proposedAt: status === "candidate" ? null : ago(HOUR),
		createdAt: ago(HOUR),
		updatedAt: ago(HOUR),
	});
	await db.insert(latchMembers).values([
		{ latchId: id, userId: a.userId },
		{ latchId: id, userId: b.userId },
	]);
	const [low, high] =
		a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
	await db
		.insert(proposalHistory)
		.values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: id,
			outcome: "proposed",
			createdAt: ago(HOUR),
			updatedAt: ago(HOUR),
		})
		.onConflictDoUpdate({
			target: [proposalHistory.userLow, proposalHistory.userHigh],
			set: { latchId: id },
		});
	return id;
};

/** 既存の有効なyes回答を配置する(partial_acceptの配置用) */
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

const setupPair = async (form: Form, opts: LatchOpts = {}) => {
	const ua = await insertUser();
	const ub = await insertUser();
	const a = await insertIntent(ua, form);
	const b = await insertIntent(ub, form);
	const latchId = await insertLatch(a, b, opts);
	return { a, b, latchId, ua, ub };
};

const latchOf = async (id: string) => {
	const [row] = await db.select().from(latches).where(eq(latches.id, id));
	return row;
};

const intentOf = async (id: string) => {
	const [row] = await db.select().from(intents).where(eq(intents.id, id));
	return row;
};

const notificationsOf = (latchId: string, type: "matched" | "closed") =>
	db
		.select()
		.from(notifications)
		.where(
			and(eq(notifications.latchId, latchId), eq(notifications.type, type)),
		);

const eventsOf = (latchId: string) =>
	db
		.select()
		.from(latchStatusEvents)
		.where(eq(latchStatusEvents.latchId, latchId));

const responsesOf = (latchId: string) =>
	db.select().from(latchResponses).where(eq(latchResponses.latchId, latchId));

const historyOf = async (latchId: string) => {
	const [row] = await db
		.select()
		.from(proposalHistory)
		.where(eq(proposalHistory.latchId, latchId));
	return row;
};

describe("respond(yes)", () => {
	it("(a) Aのyesでpartial_accept・Bのyesでmatched・履歴matched・matched通知2件・二度目はalready_responded", async () => {
		const { latchId, ua, ub } = await setupPair("occasion");

		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("partial_accept");
		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: false,
			reason: "already_responded",
		});

		const t2 = new Date(NOW.getTime() + MIN);
		expect(await respond(db, latchId, ub, "yes", t2)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("matched");
		expect((await historyOf(latchId))?.outcome).toBe("matched");
		expect(await notificationsOf(latchId, "matched")).toHaveLength(2);
		const events = await eventsOf(latchId);
		expect(events.map((e) => [e.fromStatus, e.toStatus]).sort()).toEqual([
			["partial_accept", "matched"],
			["proposed", "partial_accept"],
		]);
	});

	it("双方yesで成立した時点のlast_message_atは成立時刻になる(docs/05 §2.2)", async () => {
		const { latchId, ua, ub } = await setupPair("connection");
		const t1 = new Date(NOW.getTime() - MIN);
		await respond(db, latchId, ua, "yes", t1);
		const afterPartial = await latchOf(latchId);
		expect(afterPartial?.status).toBe("partial_accept");
		expect(afterPartial?.lastMessageAt.getTime()).toBe(ago(HOUR).getTime());

		await respond(db, latchId, ub, "yes", NOW);
		const afterMatched = await latchOf(latchId);
		expect(afterMatched?.status).toBe("matched");
		expect(afterMatched?.lastMessageAt.getTime()).toBe(NOW.getTime());
	});

	it("(b) A・Bのyesを同時に送ってもmatchedになり、matchedへの遷移記録は1件・通知は2件", async () => {
		const { latchId, ua, ub } = await setupPair("connection");

		const [ra, rb] = await Promise.all([
			respond(db, latchId, ua, "yes", NOW),
			respond(db, latchId, ub, "yes", NOW),
		]);
		expect(ra).toEqual({ ok: true, latchId });
		expect(rb).toEqual({ ok: true, latchId });
		expect((await latchOf(latchId))?.status).toBe("matched");
		const events = await eventsOf(latchId);
		expect(events.filter((e) => e.toStatus === "matched")).toHaveLength(1);
		expect(await notificationsOf(latchId, "matched")).toHaveLength(2);
		expect((await historyOf(latchId))?.outcome).toBe("matched");
	});

	it("(e) 回答期限の経過後(Cron未実行)のyesはdeadline_passedで、状態は変わらず回答行も残らない", async () => {
		const { latchId, ua } = await setupPair("occasion", {
			deadline: ago(MIN),
		});
		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: false,
			reason: "deadline_passed",
		});
		expect((await latchOf(latchId))?.status).toBe("proposed");
		expect(await responsesOf(latchId)).toHaveLength(0);
		expect(await eventsOf(latchId)).toHaveLength(0);
	});

	it("(e') 回答期限ちょうどのyesもdeadline_passed", async () => {
		const { latchId, ua } = await setupPair("occasion", { deadline: NOW });
		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: false,
			reason: "deadline_passed",
		});
		expect(await responsesOf(latchId)).toHaveLength(0);
	});

	it("閉じたLATCHへのyesはinvalid_status", async () => {
		const { latchId, ua } = await setupPair("occasion", {
			status: "rejected",
		});
		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
		expect(await responsesOf(latchId)).toHaveLength(0);
	});
});

describe("respond(defer/no)", () => {
	it("(c) deferでrejected・履歴deferred・参加者全員にclosed通知・回答行はdefer", async () => {
		const { latchId, ua } = await setupPair("occasion");
		expect(await respond(db, latchId, ua, "defer", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("rejected");
		expect((await historyOf(latchId))?.outcome).toBe("deferred");
		expect(await notificationsOf(latchId, "closed")).toHaveLength(2);
		const rows = await responsesOf(latchId);
		expect(rows.map((r) => [r.userId, r.response])).toEqual([[ua, "defer"]]);
	});

	it("(d) noでrejected・履歴rejected", async () => {
		const { latchId, ub } = await setupPair("connection");
		expect(await respond(db, latchId, ub, "no", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("rejected");
		expect((await historyOf(latchId))?.outcome).toBe("rejected");
	});

	it("partial_acceptで相手がyes済みでもdeferで閉じる。自分がyes済みならalready_responded", async () => {
		const { latchId, ua, ub } = await setupPair("occasion", {
			status: "partial_accept",
		});
		await insertYes(latchId, ua);
		expect(await respond(db, latchId, ua, "defer", NOW)).toEqual({
			ok: false,
			reason: "already_responded",
		});
		expect(await respond(db, latchId, ub, "defer", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("rejected");
	});

	it("Aのyes(partial_acceptへ)の後にBのdeferが成功してrejectedになる", async () => {
		const { latchId, ua, ub } = await setupPair("occasion");
		expect(await respond(db, latchId, ua, "yes", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("partial_accept");
		expect(await respond(db, latchId, ub, "defer", NOW)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("rejected");
	});

	it("期限経過後のdeferはdeadline_passedで回答行を残さない", async () => {
		const { latchId, ua } = await setupPair("occasion", {
			deadline: ago(MIN),
		});
		expect(await respond(db, latchId, ua, "defer", NOW)).toEqual({
			ok: false,
			reason: "deadline_passed",
		});
		expect((await latchOf(latchId))?.status).toBe("proposed");
		expect(await responsesOf(latchId)).toHaveLength(0);
	});
});

describe("retract", () => {
	it("(f) partial_acceptで自分のyesを取り消すとproposedに戻り、再度のyesでpartial_acceptになる", async () => {
		const { latchId, ua } = await setupPair("occasion");
		await respond(db, latchId, ua, "yes", NOW);

		const t2 = new Date(NOW.getTime() + MIN);
		expect(await retract(db, latchId, ua, t2)).toEqual({ ok: true, latchId });
		expect((await latchOf(latchId))?.status).toBe("proposed");
		const [row] = await responsesOf(latchId);
		expect(row?.retractedAt?.getTime()).toBe(t2.getTime());
		expect(
			(await eventsOf(latchId)).some(
				(e) => e.fromStatus === "partial_accept" && e.toStatus === "proposed",
			),
		).toBe(true);
		expect(await retract(db, latchId, ua, t2)).toEqual({
			ok: false,
			reason: "invalid_status",
		});

		const t3 = new Date(NOW.getTime() + 2 * MIN);
		expect(await respond(db, latchId, ua, "yes", t3)).toEqual({
			ok: true,
			latchId,
		});
		expect((await latchOf(latchId))?.status).toBe("partial_accept");
		const rows = await responsesOf(latchId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.retractedAt).toBeNull();
		expect(rows[0]?.respondedAt.getTime()).toBe(t3.getTime());
	});

	it("(g) Bのyesでmatchedになった後のAのretractはinvalid_statusでmatchedのまま", async () => {
		const { latchId, ua, ub } = await setupPair("occasion");
		await respond(db, latchId, ua, "yes", NOW);
		await respond(db, latchId, ub, "yes", NOW);
		expect(await retract(db, latchId, ua, NOW)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
		expect((await latchOf(latchId))?.status).toBe("matched");
		const rows = await responsesOf(latchId);
		expect(rows.every((r) => r.retractedAt === null)).toBe(true);
	});

	it("期限経過後のretractはdeadline_passed", async () => {
		const { latchId, ua } = await setupPair("occasion", {
			status: "partial_accept",
			deadline: ago(MIN),
		});
		await insertYes(latchId, ua);
		expect(await retract(db, latchId, ua, NOW)).toEqual({
			ok: false,
			reason: "deadline_passed",
		});
		expect((await latchOf(latchId))?.status).toBe("partial_accept");
	});
});

describe("成立後処理", () => {
	it("(h) 機会: 同じIntentを含む他のLATCH(提案中・保留)はcancelledになり、参加Intentはmatched", async () => {
		const ux = await insertUser();
		const u1 = await insertUser();
		const u2 = await insertUser();
		const u3 = await insertUser();
		const x = await insertIntent(ux, "occasion");
		const y1 = await insertIntent(u1, "occasion");
		const y2 = await insertIntent(u2, "occasion");
		const y3 = await insertIntent(u3, "occasion");
		const l1 = await insertLatch(x, y1);
		const l2 = await insertLatch(x, y2, { status: "partial_accept" });
		await insertYes(l2, u2);
		const l3 = await insertLatch(x, y3, { status: "candidate" });

		await respond(db, l1, ux, "yes", NOW);
		expect(await respond(db, l1, u1, "yes", NOW)).toEqual({
			ok: true,
			latchId: l1,
		});

		expect((await latchOf(l1))?.status).toBe("matched");
		expect((await latchOf(l2))?.status).toBe("cancelled");
		expect((await latchOf(l3))?.status).toBe("cancelled");
		// 排他(システムの都合)で閉じた提案は履歴を消費しない(オーナー裁定 2026-10-20)
		expect(await historyOf(l2)).toBeUndefined();
		expect(await historyOf(l3)).toBeUndefined();
		// 提示済みのL2のみclosed通知(保留のL3は未提示)
		expect(await notificationsOf(l2, "closed")).toHaveLength(2);
		expect(await notificationsOf(l3, "closed")).toHaveLength(0);
		const xi = await intentOf(x.id);
		expect(xi?.status).toBe("matched");
		expect(xi?.version).toBe(1);
		expect(xi?.updatedAt.getTime()).toBe(NOW.getTime());
		expect((await intentOf(y1.id))?.status).toBe("matched");
		expect((await intentOf(y2.id))?.status).toBe("active");
		expect((await intentOf(y3.id))?.status).toBe("active");
	});

	/** 機会Intent X(ux)を含む L1(X–Y1)・L2(X–Y2) を、X側のyes済みのpartial_acceptで配置する */
	const setupSharedIntent = async () => {
		const ux = await insertUser();
		const u1 = await insertUser();
		const u2 = await insertUser();
		const x = await insertIntent(ux, "occasion");
		const y1 = await insertIntent(u1, "occasion");
		const y2 = await insertIntent(u2, "occasion");
		const l1 = await insertLatch(x, y1, { status: "partial_accept" });
		const l2 = await insertLatch(x, y2, { status: "partial_accept" });
		await insertYes(l1, ux);
		await insertYes(l2, ux);
		return { x, y1, y2, l1, l2, u1, u2 };
	};

	it("(h2) 同じ機会Intentを含む2つのLATCHへの同時のyesでも、成立するのはちょうど1件", async () => {
		const { x, l1, l2, u1, u2 } = await setupSharedIntent();

		await Promise.all([
			respond(db, l1, u1, "yes", NOW),
			respond(db, l2, u2, "yes", NOW),
		]);

		const statuses = [(await latchOf(l1))?.status, (await latchOf(l2))?.status];
		expect(statuses.filter((s) => s === "matched")).toHaveLength(1);
		expect(statuses.filter((s) => s === "cancelled")).toHaveLength(1);
		expect((await intentOf(x.id))?.status).toBe("matched");
		const matchedEvents = [
			...(await eventsOf(l1)),
			...(await eventsOf(l2)),
		].filter((e) => e.toStatus === "matched");
		expect(matchedEvents).toHaveLength(1);
	});

	it("(h3) 後着のyesは invalid_status で、先に成立したLATCHのみがmatched", async () => {
		const { x, y1, l1, l2, u1, u2 } = await setupSharedIntent();

		expect(await respond(db, l1, u1, "yes", NOW)).toEqual({
			ok: true,
			latchId: l1,
		});
		expect(await respond(db, l2, u2, "yes", NOW)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
		expect((await latchOf(l1))?.status).toBe("matched");
		expect((await latchOf(l2))?.status).toBe("cancelled");
		expect((await intentOf(x.id))?.status).toBe("matched");
		expect((await intentOf(y1.id))?.status).toBe("matched");
	});

	it("(h4) 参加Intentが既にmatched(排他の後続処理の前)なら、yesのバッチは何も書かずinvalid_status", async () => {
		const { x, l2, u2 } = await setupSharedIntent();
		// 別のLATCHの成立バッチがXをmatchedにした直後(onMatchedの排他がL2を閉じる前)を再現する
		await db
			.update(intents)
			.set({ status: "matched" })
			.where(eq(intents.id, x.id));

		expect(await respond(db, l2, u2, "yes", NOW)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
		expect((await latchOf(l2))?.status).toBe("partial_accept");
		const rows = await responsesOf(l2);
		expect(rows.map((r) => r.userId)).not.toContain(u2);
		expect(await eventsOf(l2)).toHaveLength(0);
	});

	it("(i) つながりの成立では両Intentはactiveのまま", async () => {
		const { a, b, latchId, ua, ub } = await setupPair("connection");
		await respond(db, latchId, ua, "yes", NOW);
		await respond(db, latchId, ub, "yes", NOW);
		expect((await latchOf(latchId))?.status).toBe("matched");
		expect((await intentOf(a.id))?.status).toBe("active");
		expect((await intentOf(b.id))?.status).toBe("active");
	});
});

describe("leave", () => {
	it("matchedからcancelledへ・履歴はmatchedのまま。matched以外はinvalid_status", async () => {
		const { latchId, ua, ub } = await setupPair("occasion");
		expect(await leave(db, latchId, ua, NOW)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
		await respond(db, latchId, ua, "yes", NOW);
		await respond(db, latchId, ub, "yes", NOW);

		const t2 = new Date(NOW.getTime() + MIN);
		expect(await leave(db, latchId, ub, t2)).toEqual({ ok: true, latchId });
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		expect((await historyOf(latchId))?.outcome).toBe("matched");
		expect(await leave(db, latchId, ua, t2)).toEqual({
			ok: false,
			reason: "invalid_status",
		});
	});

	it("leaveではclosed通知を作らない(closedは不成立の総称で成立後の離脱を含まない・05 §2.2)", async () => {
		const { latchId, ua, ub } = await setupPair("connection");
		await respond(db, latchId, ua, "yes", NOW);
		await respond(db, latchId, ub, "yes", NOW);
		const t2 = new Date(NOW.getTime() + MIN);
		expect(await leave(db, latchId, ua, t2)).toEqual({ ok: true, latchId });
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		expect(await notificationsOf(latchId, "closed")).toHaveLength(0);
	});
});

describe("not_found", () => {
	it("(j) 非参加者・存在しないLATCH・保留(candidate)のLATCHはnot_found", async () => {
		const { latchId } = await setupPair("occasion");
		const outsider = await insertUser();
		const notFound = { ok: false, reason: "not_found" };
		expect(await respond(db, latchId, outsider, "yes", NOW)).toEqual(notFound);
		expect(await retract(db, latchId, outsider, NOW)).toEqual(notFound);
		expect(await leave(db, latchId, outsider, NOW)).toEqual(notFound);
		expect(await saveDeferReason(db, latchId, outsider, "other")).toEqual(
			notFound,
		);
		expect(await respond(db, ulid(), outsider, "yes", NOW)).toEqual(notFound);

		const held = await setupPair("occasion", { status: "candidate" });
		expect(await respond(db, held.latchId, held.ua, "yes", NOW)).toEqual(
			notFound,
		);
		expect(await respond(db, held.latchId, held.ua, "defer", NOW)).toEqual(
			notFound,
		);
		expect((await latchOf(held.latchId))?.status).toBe("candidate");
	});
});

describe("saveDeferReason", () => {
	it("(k) defer後は1回だけ保存でき、2回目はalready_responded。yes回答者・未回答者はnot_deferred", async () => {
		const { latchId, ua, ub } = await setupPair("occasion");
		expect(await saveDeferReason(db, latchId, ua, "other")).toEqual({
			ok: false,
			reason: "not_deferred",
		});
		await respond(db, latchId, ua, "defer", NOW);
		expect(await saveDeferReason(db, latchId, ua, "schedule_mismatch")).toEqual(
			{ ok: true, latchId },
		);
		expect(await saveDeferReason(db, latchId, ua, "other")).toEqual({
			ok: false,
			reason: "already_responded",
		});
		const [row] = await responsesOf(latchId);
		expect(row?.deferReason).toBe("schedule_mismatch");
		expect(await saveDeferReason(db, latchId, ub, "other")).toEqual({
			ok: false,
			reason: "not_deferred",
		});

		const other = await setupPair("occasion");
		await respond(db, other.latchId, other.ua, "yes", NOW);
		expect(
			await saveDeferReason(db, other.latchId, other.ua, "no_capacity"),
		).toEqual({ ok: false, reason: "not_deferred" });
	});
});
