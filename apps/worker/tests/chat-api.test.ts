/**
 * チャットのREST・チケット・WebSocket接続ルートの統合試験(F6a設計 §1.1・§2.2・§3.1・§3.4)。
 * 登録は実フロー(auth/token→POST /v1/users)、LATCH・membersは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import type { ChatServerFrame, MessageDTO, MessagePage } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { issueChatTicket } from "../src/chat/ticket";
import type { Clock } from "../src/clock/clock";
import {
	intents,
	latches,
	latchMembers,
	messages,
	proposalHistory,
} from "../src/db/schema";
import { jwtSecret, type Env as WorkerEnv } from "../src/env";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign((await importJWK(privateJwk, "RS256")) as CryptoKey);
};

const HOUR = 60 * 60_000;

interface Account {
	token: string;
	id: string;
}

/** 実フローで登録し、トークンとユーザーIDを返す */
const registerUser = async (label: string): Promise<Account> => {
	const tokenRes = await SELF.fetch("https://localhost/v1/auth/token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "google",
			idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
		}),
	});
	const pre = (await tokenRes.json()) as { access_token: string };
	const regRes = await SELF.fetch("https://localhost/v1/users", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${pre.access_token}`,
		},
		body: JSON.stringify({
			display_name: `${label}さん`,
			birth_date: "1990-01-01",
		}),
	});
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { token: body.access_token, id: body.user.id };
};

const call = (
	method: "GET" | "POST",
	path: string,
	token: string | undefined,
	body?: unknown,
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const insertIntent = async (userId: string): Promise<string> => {
	const id = ulid();
	const now = new Date();
	await db.insert(intents).values({
		id,
		userId,
		form: "connection",
		topic: "APIの主題",
		category: null,
		rawText: "API試験用",
		startsAt: null,
		endsAt: null,
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
		expiresAt: new Date(now.getTime() + 30 * 24 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: now,
		updatedAt: now,
	});
	return id;
};

/** aを参加者に含む2人のつながりLATCHを配置する(回答期限は1時間後) */
const seedLatch = async (
	a: Account,
	b: Account,
	status: SeedStatus,
	withHistory = true,
): Promise<string> => {
	const ia = await insertIntent(a.id);
	const ib = await insertIntent(b.id);
	const id = ulid();
	const now = new Date();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds: [ia, ib],
		proposal: {
			form: "connection",
			topic: "秘密の主題",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		},
		score: 0.9,
		status,
		responseDeadline: new Date(now.getTime() + HOUR),
		expiresAt: new Date(now.getTime() + 24 * HOUR),
		lastMessageAt: now,
		completedAt: null,
		proposedAt: status === "candidate" ? null : now,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(latchMembers).values([
		{ latchId: id, userId: a.id },
		{ latchId: id, userId: b.id },
	]);
	if (withHistory) {
		const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: id,
			outcome: "proposed",
			createdAt: now,
			updatedAt: now,
		});
	}
	return id;
};

type SeedStatus = "candidate" | "proposed" | "matched" | "completed";

const setup = async (status: SeedStatus = "matched") => {
	const a = await registerUser("甲");
	const b = await registerUser("乙");
	const id = await seedLatch(a, b, status);
	return { a, b, id };
};

const getTicket = async (token: string, latchId: string): Promise<string> => {
	const res = await call("POST", "/v1/ws-ticket", token, {
		scope: "chat",
		latch_id: latchId,
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { ticket: string }).ticket;
};

const reasonsOf = async (res: Response): Promise<unknown> =>
	((await res.json()) as { error: { details: { reasons?: string[] } } }).error
		.details.reasons;

interface Client {
	ws: WebSocket;
	next(): Promise<ChatServerFrame>;
}

const sockets: WebSocket[] = [];
afterEach(() => {
	for (const ws of sockets.splice(0)) ws.close();
});

const wsFetch = (latchId: string, ticket: string, upgrade = true) =>
	SELF.fetch(`https://localhost/v1/latches/${latchId}/ws?ticket=${ticket}`, {
		headers: upgrade ? { Upgrade: "websocket" } : {},
	});

const connect = async (latchId: string, ticket: string): Promise<Client> => {
	const res = await wsFetch(latchId, ticket);
	expect(res.status).toBe(101);
	const ws = res.webSocket;
	if (ws === null) throw new Error("webSocketが無い");
	ws.accept();
	sockets.push(ws);
	const received: string[] = [];
	const waiters: ((v: string) => void)[] = [];
	ws.addEventListener("message", (ev) => {
		const data = String(ev.data);
		const w = waiters.shift();
		if (w) w(data);
		else received.push(data);
	});
	return {
		ws,
		next: () => {
			const v = received.shift();
			if (v !== undefined) return Promise.resolve(JSON.parse(v));
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("フレームが届かない")),
					3000,
				);
				waiters.push((d) => {
					clearTimeout(timer);
					resolve(JSON.parse(d));
				});
			});
		},
	};
};

describe("POST /v1/ws-ticket", () => {
	it("matchedなら200でチケットとexpires_in=60を返す", async () => {
		const { a, id } = await setup("matched");
		const res = await call("POST", "/v1/ws-ticket", a.token, {
			scope: "chat",
			latch_id: id,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ticket: string; expires_in: number };
		expect(body.expires_in).toBe(60);
		expect(body.ticket.length).toBeGreaterThan(10);
	});

	it("completedは400 read_only", async () => {
		const { a, id } = await setup("completed");
		const res = await call("POST", "/v1/ws-ticket", a.token, {
			scope: "chat",
			latch_id: id,
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["read_only"]);
	});

	it("proposedは400 invalid_status", async () => {
		const { a, id } = await setup("proposed");
		const res = await call("POST", "/v1/ws-ticket", a.token, {
			scope: "chat",
			latch_id: id,
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);
	});

	it("非参加は404", async () => {
		const { id } = await setup("matched");
		const c = await registerUser("丙");
		const res = await call("POST", "/v1/ws-ticket", c.token, {
			scope: "chat",
			latch_id: id,
		});
		expect(res.status).toBe(404);
	});

	it("scope不正は400", async () => {
		const { a, id } = await setup("matched");
		const res = await call("POST", "/v1/ws-ticket", a.token, {
			scope: "other",
			latch_id: id,
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/latches/:id/ws", () => {
	it("有効なチケットで101", async () => {
		const { a, id } = await setup();
		await connect(id, await getTicket(a.token, id));
	});

	it("Upgradeヘッダがなければ426", async () => {
		const { a, id } = await setup();
		const res = await wsFetch(id, await getTicket(a.token, id), false);
		expect(res.status).toBe(426);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("UPGRADE_REQUIRED");
	});

	it("期限切れのチケットは401", async () => {
		const { a, id } = await setup();
		const past: Clock = { now: () => new Date(Date.now() - 120_000) };
		const { ticket } = await issueChatTicket(
			jwtSecret(env as unknown as WorkerEnv),
			past,
			{
				userId: a.id,
				latchId: id,
			},
		);
		expect((await wsFetch(id, ticket)).status).toBe(401);
	});

	it("チケットなし・不正は401", async () => {
		const { id } = await setup();
		expect((await wsFetch(id, "")).status).toBe(401);
		expect((await wsFetch(id, "garbage")).status).toBe(401);
	});

	it("別LATCHのチケットは401", async () => {
		const { a, id } = await setup();
		const other = await setup();
		const t = await getTicket(a.token, id);
		expect((await wsFetch(other.id, t)).status).toBe(401);
	});

	it("チケットの再使用は401", async () => {
		const { a, id } = await setup();
		const t = await getTicket(a.token, id);
		await connect(id, t);
		expect((await wsFetch(id, t)).status).toBe(401);
	});

	it("チケット発行後にleft_atを立てると401", async () => {
		const { a, id } = await setup();
		const t = await getTicket(a.token, id);
		await db
			.update(latchMembers)
			.set({ leftAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect((await wsFetch(id, t)).status).toBe(401);
	});

	it("クライアントが付けたx-user-idは無視される(チケットの本人として接続する)", async () => {
		const { a, b, id } = await setup();
		const t = await getTicket(a.token, id);
		const res = await SELF.fetch(
			`https://localhost/v1/latches/${id}/ws?ticket=${t}`,
			{ headers: { Upgrade: "websocket", "x-user-id": b.id } },
		);
		expect(res.status).toBe(101);
		res.webSocket?.accept();
		if (res.webSocket) sockets.push(res.webSocket);
	});
});

describe("GET/POST /v1/latches/:id/messages", () => {
	it("2人の送信が昇順で返り、client_idは本人分だけ入る", async () => {
		const { a, b, id } = await setup();
		const r1 = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "こんにちは",
			client_id: "ca-1",
		});
		expect(r1.status).toBe(201);
		const r2 = await call("POST", `/v1/latches/${id}/messages`, b.token, {
			body: "どうも",
			client_id: "cb-1",
		});
		expect(r2.status).toBe(201);
		const res = await call("GET", `/v1/latches/${id}/messages`, a.token);
		expect(res.status).toBe(200);
		const page = (await res.json()) as MessagePage;
		expect(page.items.map((m) => m.body)).toEqual(["こんにちは", "どうも"]);
		expect(page.items[0].client_id).toBe("ca-1");
		expect(page.items[1].client_id).toBeNull();
		expect(page.next_before).toBeNull();
	});

	it("beforeがULID形式外は400", async () => {
		const { a, id } = await setup();
		const res = await call(
			"GET",
			`/v1/latches/${id}/messages?before=xyz`,
			a.token,
		);
		expect(res.status).toBe(400);
	});

	it("proposedは400・非参加は404・hidden_atは404", async () => {
		const p = await setup("proposed");
		expect(
			(await call("GET", `/v1/latches/${p.id}/messages`, p.a.token)).status,
		).toBe(400);
		const { a, id } = await setup("matched");
		const c = await registerUser("丙");
		expect(
			(await call("GET", `/v1/latches/${id}/messages`, c.token)).status,
		).toBe(404);
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect(
			(await call("GET", `/v1/latches/${id}/messages`, a.token)).status,
		).toBe(404);
	});

	it("REST送信がWS接続中の相手へ届く", async () => {
		const { a, b, id } = await setup();
		const cb = await connect(id, await getTicket(b.token, id));
		const res = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "届くはず",
			client_id: "ca-2",
		});
		expect(res.status).toBe(201);
		const frame = await cb.next();
		expect(frame.type).toBe("message");
		if (frame.type === "message") {
			expect(frame.body).toBe("届くはず");
			expect(frame.client_id).toBeNull();
		}
	});

	it("completedへの送信は400 read_only", async () => {
		const { a, id } = await setup("completed");
		const res = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "x",
			client_id: "c1",
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["read_only"]);
	});

	it("空白本文は400 invalid_message・形の不正は理由なし400・非参加は404", async () => {
		const { a, id } = await setup();
		const res = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "  \n ",
			client_id: "c1",
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_message"]);
		const bad = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "x",
			client_id: "!!",
		});
		expect(bad.status).toBe(400);
		expect(await reasonsOf(bad)).toBeUndefined();
		const c = await registerUser("丙");
		const nf = await call("POST", `/v1/latches/${id}/messages`, c.token, {
			body: "x",
			client_id: "c1",
		});
		expect(nf.status).toBe(404);
	});

	it("WSで送ったclient_idをRESTで再送しても同じidで1件だけ", async () => {
		const { a, id } = await setup();
		const ca = await connect(id, await getTicket(a.token, id));
		ca.ws.send(
			JSON.stringify({ type: "message", body: "一度だけ", client_id: "dup-1" }),
		);
		const sent = await ca.next();
		expect(sent.type).toBe("message");
		const res = await call("POST", `/v1/latches/${id}/messages`, a.token, {
			body: "一度だけ",
			client_id: "dup-1",
		});
		expect(res.status).toBe(201);
		const dto = (await res.json()) as MessageDTO;
		if (sent.type === "message") expect(dto.id).toBe(sent.id);
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.latchId, id));
		expect(rows).toHaveLength(1);
	});
});

describe("POST /v1/latches/:id/read", () => {
	it("204・別LATCHのメッセージIDは400 unknown_message・completedでも204", async () => {
		const { a, id } = await setup();
		const sent = (await (
			await call("POST", `/v1/latches/${id}/messages`, a.token, {
				body: "既読用",
				client_id: "r1",
			})
		).json()) as MessageDTO;
		const ok = await call("POST", `/v1/latches/${id}/read`, a.token, {
			last_read_message_id: sent.id,
		});
		expect(ok.status).toBe(204);

		const other = await setup();
		const unknown = await call(
			"POST",
			`/v1/latches/${other.id}/read`,
			other.a.token,
			{
				last_read_message_id: sent.id,
			},
		);
		expect(unknown.status).toBe(400);
		expect(await reasonsOf(unknown)).toEqual(["unknown_message"]);

		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		const done = await call("POST", `/v1/latches/${id}/read`, a.token, {
			last_read_message_id: sent.id,
		});
		expect(done.status).toBe(204);
	});

	it("非参加は404・保留(proposed)は400 invalid_status", async () => {
		const { id } = await setup();
		const c = await registerUser("丙");
		expect(
			(
				await call("POST", `/v1/latches/${id}/read`, c.token, {
					last_read_message_id: ulid(),
				})
			).status,
		).toBe(404);
		const p = await setup("proposed");
		const res = await call("POST", `/v1/latches/${p.id}/read`, p.a.token, {
			last_read_message_id: ulid(),
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);
	});
});
