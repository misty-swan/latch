/**
 * ChatRoomDOの統合試験(F6a設計 §1・§2.4・§3.4)。
 * LATCH・membersは直接INSERTで配置し、DOへはenv.CHAT_DOのstubで直接/connectする
 * (ルートのチケット検証はchat-api側の試験が担う)
 */
import { env } from "cloudflare:test";
import type { ChatServerFrame, MessageDTO } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listMessages } from "../src/chat/messages";
import { forwardSend, notifyClosed } from "../src/chat/notify";
import { latches, latchMembers, messages, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";

const workerEnv = env as unknown as WorkerEnv;
const db = drizzle(workerEnv.DB);
const T0 = new Date("2026-06-01T00:00:00Z");
const T1 = new Date("2026-06-01T01:00:00Z");

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `chat-do-${id}`,
		actorType: "individual",
		displayName: "チャットDO試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: T0,
		updatedAt: T0,
	});
	return id;
};

/** n人のmatchedのLATCH */
const setup = async (n = 2) => {
	const members: string[] = [];
	for (let i = 0; i < n; i += 1) members.push(await insertUser());
	const id = ulid();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds: [],
		proposal: {},
		score: 0.9,
		status: "matched",
		responseDeadline: T0,
		expiresAt: T1,
		lastMessageAt: T0,
		createdAt: T0,
		updatedAt: T0,
	});
	await db
		.insert(latchMembers)
		.values(members.map((userId) => ({ latchId: id, userId })));
	return { id, members };
};

const stubOf = (latchId: string) =>
	workerEnv.CHAT_DO.get(workerEnv.CHAT_DO.idFromName(latchId));

interface Client {
	ws: WebSocket;
	/** 次に届くテキストフレーム(届いていればそれ)を待つ */
	next(): Promise<string>;
	/** 接続が閉じられるのを待つ(閉じたコード) */
	closed: Promise<number>;
	/** これまでに受け取ったテキストフレーム数 */
	count(): number;
}

const open: WebSocket[] = [];

const accept = (ws: WebSocket): Client => {
	ws.accept();
	open.push(ws);
	const received: string[] = [];
	const waiters: ((v: string) => void)[] = [];
	let total = 0;
	ws.addEventListener("message", (ev) => {
		total += 1;
		const data = typeof ev.data === "string" ? ev.data : "<binary>";
		const w = waiters.shift();
		if (w) w(data);
		else received.push(data);
	});
	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (ev) => resolve(ev.code));
	});
	return {
		ws,
		next: () => {
			const v = received.shift();
			if (v !== undefined) return Promise.resolve(v);
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("フレームが届かない")),
					3000,
				);
				waiters.push((d) => {
					clearTimeout(timer);
					resolve(d);
				});
			});
		},
		closed,
		count: () => total,
	};
};

const connectRaw = (latchId: string, userId: string, jti = ulid()) =>
	stubOf(latchId).fetch("https://chat-do/connect", {
		headers: {
			Upgrade: "websocket",
			"x-latch-id": latchId,
			"x-user-id": userId,
			"x-ticket-jti": jti,
			"x-ticket-exp": String(Math.floor(Date.now() / 1000) + 60),
		},
	});

const connect = async (latchId: string, userId: string): Promise<Client> => {
	const res = await connectRaw(latchId, userId);
	expect(res.status).toBe(101);
	const ws = res.webSocket;
	if (ws === null) throw new Error("webSocketが無い");
	return accept(ws);
};

const nextFrame = async (c: Client): Promise<ChatServerFrame> =>
	JSON.parse(await c.next()) as ChatServerFrame;

const sendFrame = (c: Client, body: string, clientId: string) =>
	c.ws.send(JSON.stringify({ type: "message", body, client_id: clientId }));

const postSend = (
	latchId: string,
	userId: string,
	body: string,
	clientId: string,
) =>
	stubOf(latchId).fetch("https://chat-do/send", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			latch_id: latchId,
			user_id: userId,
			body,
			client_id: clientId,
		}),
	});

const postClosed = (latchId: string, userIds: string[] | null) =>
	stubOf(latchId).fetch("https://chat-do/closed", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ latch_id: latchId, user_ids: userIds }),
	});

const countOf = async (id: string) =>
	(await db.select().from(messages).where(eq(messages.latchId, id))).length;

afterEach(async () => {
	// 閉じ終わり(相手側のclose)を待つ(1秒の打ち切り)。DOのwebSocketCloseのログが試験の終了後に
	// 出ないようにする(latches-delete.test.tsと同じ片付け)。既に閉じた接続は待たない
	await Promise.all(
		open.splice(0).map(
			(ws) =>
				new Promise<void>((resolve) => {
					if (ws.readyState === WebSocket.CLOSED) {
						resolve();
						return;
					}
					ws.addEventListener("close", () => resolve());
					setTimeout(resolve, 1000);
					try {
						ws.close(1000, "test end");
					} catch {
						// 既に閉じている
						resolve();
					}
				}),
		),
	);
});

describe("ChatRoomDO", () => {
	it("接続が閉じるとchat.ws.closedをclose_code・hold_ms・latch_id付きで記録し、本文や表示名は出さない(#46)", async () => {
		const { id, members } = await setup();
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => {
			lines.push(String(l));
		});
		try {
			const c = await connect(id, members[0]);
			c.ws.close(1000, "bye");
			await c.closed;
			await vi.waitFor(() => {
				expect(lines.some((l) => l.includes("chat.ws.closed"))).toBe(true);
			});
		} finally {
			spy.mockRestore();
		}
		const line = lines.find((l) => l.includes("chat.ws.closed")) ?? "{}";
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(parsed.close_code).toBe(1000);
		expect(parsed.latch_id).toBe(id);
		expect(typeof parsed.hold_ms).toBe("number");
		expect(Object.keys(parsed).sort()).toEqual([
			"close_code",
			"event",
			"hold_ms",
			"latch_id",
			"level",
		]);
	});
	it("①WSの送信がA・Bに届き、client_idは送信者の接続だけ・D1に1行", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		sendFrame(ca, "  こんにちは  ", "c1");
		const fa = await nextFrame(ca);
		const fb = await nextFrame(cb);
		expect(fa).toMatchObject({
			type: "message",
			user_id: a,
			body: "こんにちは",
			client_id: "c1",
		});
		expect(fb).toMatchObject({
			type: "message",
			user_id: a,
			body: "こんにちは",
			client_id: null,
		});
		if (fa.type === "message" && fb.type === "message") {
			expect(fb.id).toBe(fa.id);
		}
		expect(await countOf(id)).toBe(1);
	});

	it("②/sendの送信がA・Bの接続に届き、応答201のclient_idは送信者のもの", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		const res = await postSend(id, b, "RESTから", "rest-1");
		expect(res.status).toBe(201);
		const json = (await res.json()) as { message: MessageDTO };
		expect(json.message).toMatchObject({
			user_id: b,
			body: "RESTから",
			client_id: "rest-1",
		});
		expect(await nextFrame(ca)).toMatchObject({
			type: "message",
			id: json.message.id,
			client_id: null,
		});
		expect(await nextFrame(cb)).toMatchObject({
			type: "message",
			id: json.message.id,
			client_id: "rest-1",
		});
	});

	it("②'/sendの失敗: 非参加は404・読み取り専用は400", async () => {
		const { id, members } = await setup();
		const outsider = await insertUser();
		expect((await postSend(id, outsider, "x", "c1")).status).toBe(404);
		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		const res = await postSend(id, members[0], "x", "c2");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ reason: "read_only" });
	});

	it("③同じjtiの2回目の/connectは401", async () => {
		const { id, members } = await setup();
		const jti = ulid();
		const first = await connectRaw(id, members[0], jti);
		expect(first.status).toBe(101);
		if (first.webSocket) accept(first.webSocket);
		const second = await connectRaw(id, members[0], jti);
		expect(second.status).toBe(401);
	});

	it("④不正なフレームはerror(invalid_message)で接続は維持される", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		ca.ws.send(new Uint8Array([1, 2, 3]));
		expect(await nextFrame(ca)).toEqual({
			type: "error",
			code: "invalid_message",
			client_id: null,
		});
		ca.ws.send("not json");
		expect(await nextFrame(ca)).toEqual({
			type: "error",
			code: "invalid_message",
			client_id: null,
		});
		ca.ws.send(JSON.stringify({ type: "x" }));
		expect(await nextFrame(ca)).toEqual({
			type: "error",
			code: "invalid_message",
			client_id: null,
		});
		sendFrame(ca, "   ", "blank-1");
		expect(await nextFrame(ca)).toEqual({
			type: "error",
			code: "invalid_message",
			client_id: "blank-1",
		});
		sendFrame(ca, "正しい送信", "ok-1");
		expect(await nextFrame(ca)).toMatchObject({
			type: "message",
			body: "正しい送信",
			client_id: "ok-1",
		});
		expect(await nextFrame(cb)).toMatchObject({
			type: "message",
			body: "正しい送信",
		});
		// Bには不正フレームの応答は届いていない
		expect(cb.count()).toBe(1);
		expect(await countOf(id)).toBe(1);
	});

	it("⑤3通連続の送信はBの受信順=listMessagesの順=IDの昇順", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		sendFrame(ca, "1通目", "s1");
		sendFrame(ca, "2通目", "s2");
		sendFrame(ca, "3通目", "s3");
		const got: { id: string; body: string }[] = [];
		for (let i = 0; i < 3; i += 1) {
			const f = await nextFrame(cb);
			if (f.type !== "message") throw new Error("messageでない");
			got.push({ id: f.id, body: f.body });
		}
		expect(got.map((g) => g.body)).toEqual(["1通目", "2通目", "3通目"]);
		const page = await listMessages(db, id, null);
		expect(page.items.map((m) => m.id)).toEqual(got.map((g) => g.id));
		expect([...got.map((g) => g.id)].sort()).toEqual(got.map((g) => g.id));
		void ca;
	});

	it("⑥知らせの届かなかった離脱者には配信せずclosedを送って閉じる", async () => {
		const { id, members } = await setup(3);
		const [a, b, c] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		const cc = await connect(id, c);
		await db
			.update(latchMembers)
			.set({ leftAt: T1 })
			.where(eq(latchMembers.userId, c));
		sendFrame(ca, "グループへ", "g1");
		expect(await nextFrame(ca)).toMatchObject({ type: "message" });
		expect(await nextFrame(cb)).toMatchObject({ type: "message" });
		expect(await nextFrame(cc)).toEqual({ type: "closed" });
		expect(await cc.closed).toBe(1000);
		expect(cc.count()).toBe(1);
	});

	it("⑦/closed(user_ids=[A])はAだけclosed+切断、Bは接続のまま", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		const res = await postClosed(id, [a]);
		expect(res.status).toBe(204);
		expect(await nextFrame(ca)).toEqual({ type: "closed" });
		expect(await ca.closed).toBe(1000);
		// Bは接続のままで、続く送信を受け取れる
		const sent = await postSend(id, b, "まだつながっている", "b1");
		expect(sent.status).toBe(201);
		expect(await nextFrame(cb)).toMatchObject({
			type: "message",
			body: "まだつながっている",
		});
	});

	it("⑧/closed(null)は全員を切断する", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		expect((await postClosed(id, null)).status).toBe(204);
		expect(await nextFrame(ca)).toEqual({ type: "closed" });
		expect(await nextFrame(cb)).toEqual({ type: "closed" });
		expect(await ca.closed).toBe(1000);
		expect(await cb.closed).toBe(1000);
	});

	it("⑨completedのLATCHへの送信はerror(read_only)", async () => {
		const { id, members } = await setup();
		const ca = await connect(id, members[0]);
		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		sendFrame(ca, "終わった後", "ro-1");
		expect(await nextFrame(ca)).toEqual({
			type: "error",
			code: "read_only",
			client_id: "ro-1",
		});
		expect(await countOf(id)).toBe(0);
	});

	it("⑩pingにはpongが返る", async () => {
		const { id, members } = await setup();
		const ca = await connect(id, members[0]);
		ca.ws.send("ping");
		expect(await ca.next()).toBe("pong");
	});
});

describe("notify(ルート→DOの内部呼び出し)", () => {
	it("forwardSendは送信者視点のMessageDTOを返し、接続へ配信される", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const cb = await connect(id, b);
		const r = await forwardSend(workerEnv, {
			latchId: id,
			userId: a,
			body: "転送",
			clientId: "fw-1",
		});
		expect(r).toMatchObject({
			ok: true,
			message: { user_id: a, body: "転送", client_id: "fw-1" },
		});
		expect(await nextFrame(cb)).toMatchObject({
			type: "message",
			body: "転送",
			client_id: null,
		});
	});

	it("forwardSendの失敗はreasonで返す", async () => {
		const { id, members } = await setup();
		const outsider = await insertUser();
		expect(
			await forwardSend(workerEnv, {
				latchId: id,
				userId: outsider,
				body: "x",
				clientId: "c1",
			}),
		).toEqual({ ok: false, reason: "not_found" });
		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		expect(
			await forwardSend(workerEnv, {
				latchId: id,
				userId: members[0],
				body: "x",
				clientId: "c2",
			}),
		).toEqual({ ok: false, reason: "read_only" });
	});

	it("notifyClosedは該当者の接続へclosedを送って閉じる", async () => {
		const { id, members } = await setup();
		const [a, b] = members;
		const ca = await connect(id, a);
		const cb = await connect(id, b);
		await notifyClosed(workerEnv, id, [b]);
		expect(await nextFrame(cb)).toEqual({ type: "closed" });
		expect(await cb.closed).toBe(1000);
		expect(ca.count()).toBe(0);
	});
});
