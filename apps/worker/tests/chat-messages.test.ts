/**
 * チャットメッセージのD1操作の統合試験(F6a設計 §2.1・§2.2)。
 * LATCH・members・status_eventsは直接INSERTで配置する(APIを通さない)
 */
import { env } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
	activeMemberIds,
	chatAccess,
	chatSummary,
	listMessages,
	markRead,
	sendMessage,
	toMessageDto,
} from "../src/chat/messages";
import {
	latches,
	latchMembers,
	latchStatusEvents,
	messages,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";

const db = drizzle((env as unknown as WorkerEnv).DB);
const T0 = new Date("2026-06-01T00:00:00Z");
const T1 = new Date("2026-06-01T01:00:00Z");

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `chat-messages-${id}`,
		actorType: "individual",
		displayName: "チャット試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: T0,
		updatedAt: T0,
	});
	return id;
};

interface Opts {
	status?: LatchStatus;
	viaMatched?: boolean;
	leftA?: boolean;
	hiddenA?: boolean;
}

/** 2人のLATCH。aが送り手、bが相手 */
const setup = async (opts: Opts = {}) => {
	const a = await insertUser();
	const b = await insertUser();
	const id = ulid();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds: [],
		proposal: {},
		score: 0.9,
		status: opts.status ?? "matched",
		responseDeadline: T0,
		expiresAt: T1,
		lastMessageAt: T0,
		createdAt: T0,
		updatedAt: T0,
	});
	await db.insert(latchMembers).values([
		{
			latchId: id,
			userId: a,
			leftAt: opts.leftA ? T0 : null,
			hiddenAt: opts.hiddenA ? T0 : null,
		},
		{ latchId: id, userId: b },
	]);
	if (opts.viaMatched) {
		await db.insert(latchStatusEvents).values({
			id: ulid(),
			latchId: id,
			fromStatus: "proposed",
			toStatus: "matched",
			createdAt: T0,
		});
	}
	return { id, a, b };
};

const send = (
	latchId: string,
	userId: string,
	clientId: string,
	now = T1,
	body = "こんにちは",
) => sendMessage(db, { latchId, userId, body, clientId, id: ulid(), now });

const lastAt = async (id: string) =>
	(await db.select().from(latches).where(eq(latches.id, id)))[0]?.lastMessageAt;

const countOf = async (id: string) =>
	(await db.select().from(messages).where(eq(messages.latchId, id))).length;

describe("sendMessage", () => {
	it("matchedで保存でき、last_message_atがnowになる", async () => {
		const { id, a } = await setup();
		const r = await send(id, a, "c1");
		expect(r.ok).toBe(true);
		expect(await countOf(id)).toBe(1);
		expect((await lastAt(id))?.getTime()).toBe(T1.getTime());
	});

	it("保存できない状態では行もlast_message_atも変わらない", async () => {
		const cases: [Opts, string][] = [
			[{ status: "completed" }, "read_only"],
			[{ status: "cancelled", viaMatched: true }, "read_only"],
			[{ status: "cancelled" }, "invalid_status"],
			[{ status: "proposed" }, "invalid_status"],
			[{ status: "candidate" }, "not_found"],
			[{ leftA: true }, "not_found"],
			[{ hiddenA: true }, "not_found"],
		];
		for (const [opts, reason] of cases) {
			const { id, a } = await setup(opts);
			const r = await send(id, a, "c1");
			expect(r).toEqual({ ok: false, reason });
			expect(await countOf(id)).toBe(0);
			expect((await lastAt(id))?.getTime()).toBe(T0.getTime());
		}
		const { id } = await setup();
		const outsider = await insertUser();
		expect(await send(id, outsider, "c1")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await send(ulid(), outsider, "c1")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("同じclient_idの2回目は同じidの行を返し、行は1件", async () => {
		const { id, a } = await setup();
		const first = await send(id, a, "dup", T0);
		const second = await send(id, a, "dup", T1, "別本文");
		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(second.message.id).toBe(first.message.id);
			expect(second.message.body).toBe("こんにちは");
		}
		expect(await countOf(id)).toBe(1);
		// 2回目は挿入されないのでlast_message_atも進まない
		expect((await lastAt(id))?.getTime()).toBe(T0.getTime());
	});

	it("別ユーザーが同じclient_idでも別行で保存される", async () => {
		const { id, a, b } = await setup();
		const ra = await send(id, a, "same");
		const rb = await send(id, b, "same");
		expect(ra.ok && rb.ok).toBe(true);
		expect(await countOf(id)).toBe(2);
	});
});

describe("listMessages", () => {
	it("120件を50件ずつ、ID昇順・nextBeforeは返した最古", async () => {
		const { id, a } = await setup();
		const ids: string[] = [];
		for (let i = 0; i < 120; i += 1) {
			const mid = ulid(T1.getTime() + i);
			ids.push(mid);
			const r = await sendMessage(db, {
				latchId: id,
				userId: a,
				body: `m${i}`,
				clientId: `c${i}`,
				id: mid,
				now: T1,
			});
			expect(r.ok).toBe(true);
		}
		const p1 = await listMessages(db, id, null);
		expect(p1.items.map((m) => m.id)).toEqual(ids.slice(70, 120));
		expect(p1.nextBefore).toBe(ids[70]);
		const p2 = await listMessages(db, id, p1.nextBefore);
		expect(p2.items.map((m) => m.id)).toEqual(ids.slice(20, 70));
		expect(p2.nextBefore).toBe(ids[20]);
		const p3 = await listMessages(db, id, p2.nextBefore);
		expect(p3.items.map((m) => m.id)).toEqual(ids.slice(0, 20));
		expect(p3.nextBefore).toBeNull();
	});
});

describe("markRead / chatSummary", () => {
	it("既読は前にだけ進み、別LATCHのIDはunknown_message", async () => {
		const { id, a, b } = await setup();
		const other = await setup();
		const m1 = ulid(T1.getTime());
		const m2 = ulid(T1.getTime() + 1);
		for (const [mid, c] of [
			[m1, "x1"],
			[m2, "x2"],
		] as const) {
			await sendMessage(db, {
				latchId: id,
				userId: b,
				body: "b",
				clientId: c,
				id: mid,
				now: T1,
			});
		}
		expect(await markRead(db, id, a, m2)).toEqual({ ok: true });
		expect(await markRead(db, id, a, m1)).toEqual({ ok: true });
		expect((await chatSummary(db, id, a)).unreadCount).toBe(0);
		const otherMsg = await send(other.id, other.a, "o1");
		if (!otherMsg.ok) throw new Error("setup");
		expect(await markRead(db, id, a, otherMsg.message.id)).toEqual({
			ok: false,
			reason: "unknown_message",
		});
	});

	it("本人の送信は未読に数えず、既読後は0、0件はlastMessage=null", async () => {
		const { id, a, b } = await setup();
		expect(await chatSummary(db, id, a)).toEqual({
			lastMessage: null,
			unreadCount: 0,
		});
		await sendMessage(db, {
			latchId: id,
			userId: a,
			body: "自分",
			clientId: "mine",
			id: ulid(T1.getTime()),
			now: T1,
		});
		const r1 = await sendMessage(db, {
			latchId: id,
			userId: b,
			body: "相手1",
			clientId: "t1",
			id: ulid(T1.getTime() + 10),
			now: T1,
		});
		const r2 = await sendMessage(db, {
			latchId: id,
			userId: b,
			body: "相手2",
			clientId: "t2",
			id: ulid(T1.getTime() + 20),
			now: T1,
		});
		const s = await chatSummary(db, id, a);
		expect(s.unreadCount).toBe(2);
		expect(s.lastMessage?.body).toBe("相手2");
		expect(s.lastMessage?.userId).toBe(b);
		expect((await chatSummary(db, id, b)).unreadCount).toBe(1);
		if (!r1.ok || !r2.ok) throw new Error("setup");
		await markRead(db, id, a, r1.message.id);
		expect((await chatSummary(db, id, a)).unreadCount).toBe(1);
		await markRead(db, id, a, r2.message.id);
		expect((await chatSummary(db, id, a)).unreadCount).toBe(0);
	});
});

describe("chatAccess", () => {
	it("表の全行", async () => {
		const outsider = await insertUser();
		const rows: [Opts, unknown][] = [
			[{ status: "candidate" }, { kind: "not_found" }],
			[{ status: "proposed" }, { kind: "invalid_status" }],
			[{ status: "partial_accept" }, { kind: "invalid_status" }],
			[{ status: "rejected" }, { kind: "invalid_status" }],
			[{ status: "expired" }, { kind: "invalid_status" }],
			[{ status: "cancelled" }, { kind: "invalid_status" }],
			[{ status: "matched" }, { kind: "readable", writable: true }],
			[{ status: "completed" }, { kind: "readable", writable: false }],
			[
				{ status: "cancelled", viaMatched: true },
				{ kind: "readable", writable: false },
			],
			[{ leftA: true }, { kind: "not_found" }],
			[{ hiddenA: true }, { kind: "not_found" }],
		];
		for (const [opts, expected] of rows) {
			const { id, a } = await setup(opts);
			expect(await chatAccess(db, id, a)).toEqual(expected);
			expect(await chatAccess(db, id, outsider)).toEqual({
				kind: "not_found",
			});
		}
		expect(await chatAccess(db, ulid(), outsider)).toEqual({
			kind: "not_found",
		});
	});
});

describe("activeMemberIds / toMessageDto", () => {
	it("left_at・hidden_atの人を除く", async () => {
		const { id, b } = await setup({ leftA: true });
		expect(await activeMemberIds(db, id)).toEqual([b]);
		const h = await setup({ hiddenA: true });
		expect(await activeMemberIds(db, h.id)).toEqual([h.b]);
	});

	it("client_idは本人の送信にだけ入る", () => {
		const m = {
			id: "i",
			latchId: "l",
			userId: "u1",
			body: "x",
			createdAt: T0,
			clientId: "cid",
		};
		expect(toMessageDto(m, "u1").client_id).toBe("cid");
		expect(toMessageDto(m, "u2").client_id).toBeNull();
		expect(toMessageDto(m, "u1").created_at).toBe(T0.toISOString());
	});
});
