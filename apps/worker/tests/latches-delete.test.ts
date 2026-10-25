/**
 * DELETE /v1/latches/{id}(表示から消す)と離脱・削除後のclosedの知らせの統合試験
 * (F6a設計 §0.3の2・§2.3・§2.4)。登録は実フロー(auth/token→POST /v1/users)、
 * LATCH・membersは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import type { ChatServerFrame } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
} from "../src/db/schema";
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
	method: "GET" | "POST" | "DELETE",
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
		topic: "削除試験の主題",
		category: null,
		rawText: "削除試験用",
		startsAt: null,
		endsAt: null,
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

type SeedStatus = "proposed" | "matched" | "completed";

/**
 * 参加者全員のつながりLATCHを配置する。matched・completedは成立の状態記録(to_status=matched)も置く
 * (matched経由のcancelledの判定に使う・docs/05 §3.3)
 */
const seedLatch = async (
	accounts: Account[],
	status: SeedStatus,
	min = 2,
): Promise<string> => {
	const intentIds: string[] = [];
	for (const acc of accounts) intentIds.push(await insertIntent(acc.id));
	const id = ulid();
	const now = new Date();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds,
		proposal: {
			form: "connection",
			topic: "秘密の主題",
			time_window: null,
			region_name: null,
			participants: { min, max: 4 },
			budget: null,
		},
		score: 0.9,
		status,
		responseDeadline: new Date(now.getTime() + HOUR),
		expiresAt: new Date(now.getTime() + 24 * HOUR),
		lastMessageAt: now,
		completedAt: status === "completed" ? now : null,
		proposedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(latchMembers)
		.values(accounts.map((acc) => ({ latchId: id, userId: acc.id })));
	if (status !== "proposed") {
		await db.insert(latchStatusEvents).values({
			id: ulid(),
			latchId: id,
			fromStatus: "partial_accept",
			toStatus: "matched",
			createdAt: now,
		});
	}
	return id;
};

const pair = async (status: SeedStatus = "matched") => {
	const a = await registerUser("甲");
	const b = await registerUser("乙");
	const id = await seedLatch([a, b], status);
	return { a, b, id };
};

const trio = async (min = 2) => {
	const a = await registerUser("甲");
	const b = await registerUser("乙");
	const c = await registerUser("丙");
	const id = await seedLatch([a, b, c], "matched", min);
	return { a, b, c, id };
};

const memberOf = async (latchId: string, userId: string) => {
	const [row] = await db
		.select()
		.from(latchMembers)
		.where(
			and(eq(latchMembers.latchId, latchId), eq(latchMembers.userId, userId)),
		);
	return row;
};

const statusOf = async (latchId: string) => {
	const [row] = await db
		.select({ status: latches.status })
		.from(latches)
		.where(eq(latches.id, latchId));
	return row?.status;
};

const reasonsOf = async (res: Response): Promise<unknown> =>
	((await res.json()) as { error: { details: { reasons?: string[] } } }).error
		.details.reasons;

const del = (id: string, token: string) =>
	call("DELETE", `/v1/latches/${id}`, token);

const send = (id: string, token: string, body: string) =>
	call("POST", `/v1/latches/${id}/messages`, token, {
		body,
		client_id: ulid(),
	});

type Dto = {
	id: string;
	status: string;
	participants_count: number;
	members?: { user_id: string }[];
	last_message?: unknown;
	unread_count?: number;
};

const matchedIds = async (token: string): Promise<string[]> =>
	(
		(await (await call("GET", "/v1/latches?type=matched", token)).json()) as {
			items: Dto[];
		}
	).items.map((i) => i.id);

// WebSocketの接続(chat-api.test.tsと同じ張り方)
interface Client {
	ws: WebSocket;
	next(): Promise<ChatServerFrame>;
}

const sockets: WebSocket[] = [];
afterEach(async () => {
	// 閉じ終わり(相手側のclose)を待つ。DOのwebSocketCloseのログが試験の終了後に出ないようにする
	await Promise.all(
		sockets.splice(0).map(
			(ws) =>
				new Promise<void>((resolve) => {
					ws.addEventListener("close", () => resolve());
					setTimeout(resolve, 1000);
					ws.close();
				}),
		),
	);
});

const connect = async (latchId: string, token: string): Promise<Client> => {
	const ticketRes = await call("POST", "/v1/ws-ticket", token, {
		scope: "chat",
		latch_id: latchId,
	});
	expect(ticketRes.status).toBe(200);
	const { ticket } = (await ticketRes.json()) as { ticket: string };
	const res = await SELF.fetch(
		`https://localhost/v1/latches/${latchId}/ws?ticket=${ticket}`,
		{ headers: { Upgrade: "websocket" } },
	);
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

describe("DELETE /v1/latches/:id(F6a設計 §2.3)", () => {
	it("①1対1のmatchedを消すと204・cancelled・本人のhidden_atを記録し(left_atはnullのまま)、本人のGETは404", async () => {
		const { a, id } = await pair();
		const res = await del(id, a.token);
		expect(res.status).toBe(204);
		expect(await statusOf(id)).toBe("cancelled");
		const me = await memberOf(id, a.id);
		expect(me?.hiddenAt).not.toBeNull();
		// 全体を取り消す離脱では本人のleft_atを記録しない(2026-10-21オーナー裁定・docs/01 §10)
		expect(me?.leftAt).toBeNull();
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		expect(await matchedIds(a.token)).not.toContain(id);
	});

	it("②消された相手は単一取得・一覧・履歴で読めて、送信は400 read_only", async () => {
		const { a, b, id } = await pair();
		expect((await send(id, a.token, "消す前の送信")).status).toBe(201);
		expect((await del(id, a.token)).status).toBe(204);

		const got = await call("GET", `/v1/latches/${id}`, b.token);
		expect(got.status).toBe(200);
		const dto = (await got.json()) as Dto;
		expect(dto.status).toBe("cancelled");
		// 消した本人はleft_atを持たないため、相手のmembers・participants_countには残る
		// (2026-10-21オーナー裁定・hidden_atは本人の表示だけを変える)
		expect(dto.members?.map((m) => m.user_id)).toEqual([a.id]);
		expect(dto.participants_count).toBe(2);
		expect(dto.last_message).not.toBeNull();
		expect(dto.unread_count).toBe(1);

		const list = (await (
			await call("GET", "/v1/latches?type=matched", b.token)
		).json()) as { items: Dto[] };
		const item = list.items.find((i) => i.id === id);
		expect(item?.status).toBe("cancelled");
		expect(item && "last_message" in item).toBe(true);
		expect(item?.unread_count).toBe(1);

		expect(
			(await call("GET", `/v1/latches/${id}/messages`, b.token)).status,
		).toBe(200);
		const sent = await send(id, b.token, "まだ送れる?");
		expect(sent.status).toBe(400);
		expect(await reasonsOf(sent)).toEqual(["read_only"]);
	});

	it("②'残された相手がmatched経由のcancelledを消すと204で、本人の一覧・単一取得から消える", async () => {
		const { a, b, id } = await pair();
		expect((await del(id, a.token)).status).toBe(204);
		expect((await del(id, b.token)).status).toBe(204);
		const me = await memberOf(id, b.id);
		expect(me?.hiddenAt).not.toBeNull();
		expect(me?.leftAt).toBeNull();
		expect((await call("GET", `/v1/latches/${id}`, b.token)).status).toBe(404);
		expect(await matchedIds(b.token)).not.toContain(id);
	});

	it("③3人グループ(min=2)で1人が消すとmatchedのままその人だけ外れ、残りは送れる", async () => {
		const { a, b, c, id } = await trio(2);
		expect((await del(id, a.token)).status).toBe(204);
		expect(await statusOf(id)).toBe("matched");
		expect((await memberOf(id, a.id))?.leftAt).not.toBeNull();
		expect((await memberOf(id, b.id))?.leftAt).toBeNull();
		const dto = (await (
			await call("GET", `/v1/latches/${id}`, b.token)
		).json()) as Dto;
		expect(dto.participants_count).toBe(2);
		expect(dto.members?.map((m) => m.user_id)).toEqual([c.id]);
		expect((await send(id, b.token, "続けよう")).status).toBe(201);
		expect((await send(id, c.token, "うん")).status).toBe(201);
		expect((await send(id, a.token, "消した本人")).status).toBe(404);
	});

	it("④下限2の3人グループで1人がleave済みのところへ消すとcancelled", async () => {
		const { a, c, id } = await trio(2);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, c.token)).status,
		).toBe(200);
		expect(await statusOf(id)).toBe("matched");
		expect((await del(id, a.token)).status).toBe(204);
		expect(await statusOf(id)).toBe("cancelled");
		const me = await memberOf(id, a.id);
		expect(me?.hiddenAt).not.toBeNull();
		// 下限割れで全体を取り消した本人のleft_atは記録しない(2026-10-21オーナー裁定)
		expect(me?.leftAt).toBeNull();
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
	});

	it("⑤completedを消すと204・状態は不変・left_atはnullのまま・相手の人数は不変", async () => {
		const { a, b, id } = await pair("completed");
		expect((await del(id, a.token)).status).toBe(204);
		expect(await statusOf(id)).toBe("completed");
		const me = await memberOf(id, a.id);
		expect(me?.hiddenAt).not.toBeNull();
		expect(me?.leftAt).toBeNull();
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		const dto = (await (
			await call("GET", `/v1/latches/${id}`, b.token)
		).json()) as Dto;
		expect(dto.participants_count).toBe(2);
		expect(dto.members?.map((m) => m.user_id)).toEqual([a.id]);
	});

	it("⑥proposedは400 invalid_status・非参加は404・2回目のDELETEは204", async () => {
		const p = await pair("proposed");
		const res = await del(p.id, p.a.token);
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);

		const { a, id } = await pair();
		const outsider = await registerUser("丁");
		expect((await del(id, outsider.token)).status).toBe(404);
		expect((await del(ulid(), outsider.token)).status).toBe(404);
		expect((await del(id, a.token)).status).toBe(204);
		expect((await del(id, a.token)).status).toBe(204);
	});

	it("⑥'matchedを経ないcancelledは400 invalid_status・leave済みの本人は404", async () => {
		const p = await pair("proposed");
		await db
			.update(latches)
			.set({ status: "cancelled" })
			.where(eq(latches.id, p.id));
		const res = await del(p.id, p.a.token);
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);

		const { a, id } = await trio(2);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		expect((await del(id, a.token)).status).toBe(404);
	});

	it("hidden_atを持つ本人のPOST /leaveは404(完了後に消した場合)", async () => {
		const { a, id } = await pair("completed");
		expect((await del(id, a.token)).status).toBe(204);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(404);
	});
});

describe("全体を終える離脱後の読み取り専用(2026-10-21オーナー裁定・docs/01 §10)", () => {
	const ticket = (id: string, token: string) =>
		call("POST", "/v1/ws-ticket", token, { scope: "chat", latch_id: id });

	/** 取り消し済みLATCHを読み取り専用で読めて、送信・チケットは400 read_only */
	const expectReadOnly = async (id: string, token: string) => {
		const list = (await (
			await call("GET", "/v1/latches?type=matched", token)
		).json()) as { items: Dto[] };
		expect(list.items.find((i) => i.id === id)?.status).toBe("cancelled");
		const got = await call("GET", `/v1/latches/${id}`, token);
		expect(got.status).toBe(200);
		expect(((await got.json()) as Dto).status).toBe("cancelled");
		expect(
			(await call("GET", `/v1/latches/${id}/messages`, token)).status,
		).toBe(200);
		const sent = await send(id, token, "取り消し後の送信");
		expect(sent.status).toBe(400);
		expect(await reasonsOf(sent)).toEqual(["read_only"]);
		const t = await ticket(id, token);
		expect(t.status).toBe(400);
		expect(await reasonsOf(t)).toEqual(["read_only"]);
	};

	it("(a)1対1のPOST /leave後、離脱した本人も相手も一覧にcancelledで出て、読めるが送れない", async () => {
		const { a, b, id } = await pair();
		expect((await send(id, b.token, "離脱前の送信")).status).toBe(201);
		const res = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(res.status).toBe(200);
		expect(await statusOf(id)).toBe("cancelled");
		expect((await memberOf(id, a.id))?.leftAt).toBeNull();
		await expectReadOnly(id, a.token);
		await expectReadOnly(id, b.token);
		// 既読記録は読み取り専用でもできる
		const page = (await (
			await call("GET", `/v1/latches/${id}/messages`, a.token)
		).json()) as { items: { id: string }[] };
		const lastId = page.items.at(-1)?.id;
		expect(
			(
				await call("POST", `/v1/latches/${id}/read`, a.token, {
					last_read_message_id: lastId,
				})
			).status,
		).toBe(204);
		// 相手のDTOには離脱した本人がmembersに残る
		const dto = (await (
			await call("GET", `/v1/latches/${id}`, b.token)
		).json()) as Dto;
		expect(dto.members?.map((m) => m.user_id)).toEqual([a.id]);
		expect(dto.participants_count).toBe(2);
	});

	it("(b)離脱した本人がその後DELETEすると本人は全て404になり、相手は変わらない", async () => {
		const { a, b, id } = await pair();
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		expect((await del(id, a.token)).status).toBe(204);
		expect((await memberOf(id, a.id))?.hiddenAt).not.toBeNull();
		expect(await matchedIds(a.token)).not.toContain(id);
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		expect(
			(await call("GET", `/v1/latches/${id}/messages`, a.token)).status,
		).toBe(404);
		expect((await send(id, a.token, "消した後")).status).toBe(404);
		expect((await ticket(id, a.token)).status).toBe(404);
		await expectReadOnly(id, b.token);
		const dto = (await (
			await call("GET", `/v1/latches/${id}`, b.token)
		).json()) as Dto;
		expect(dto.members?.map((m) => m.user_id)).toEqual([a.id]);
		expect(dto.participants_count).toBe(2);
	});
});

describe("離脱・削除後のclosedの知らせ(F6a設計 §2.4)", () => {
	it("⑦1対1のDELETEで相手の接続にclosedが届く", async () => {
		const { a, b, id } = await pair();
		const cb = await connect(id, b.token);
		expect((await del(id, a.token)).status).toBe(204);
		expect(await cb.next()).toEqual({ type: "closed" });
	});

	it("⑦グループのDELETEでは消した本人の接続だけにclosedが届き、相手は続けて受け取れる", async () => {
		const { a, b, id } = await trio(2);
		const ca = await connect(id, a.token);
		const cb = await connect(id, b.token);
		expect((await del(id, a.token)).status).toBe(204);
		expect(await ca.next()).toEqual({ type: "closed" });
		expect((await send(id, b.token, "まだいる")).status).toBe(201);
		expect(await cb.next()).toMatchObject({
			type: "message",
			body: "まだいる",
		});
	});

	it("⑦1対1のPOST /leaveで相手の接続にclosedが届く", async () => {
		const { a, b, id } = await pair();
		const cb = await connect(id, b.token);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		expect(await cb.next()).toEqual({ type: "closed" });
	});

	it("⑦グループのPOST /leaveでは本人の接続だけにclosedが届く", async () => {
		const { a, b, id } = await trio(2);
		const ca = await connect(id, a.token);
		const cb = await connect(id, b.token);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		expect(await ca.next()).toEqual({ type: "closed" });
		expect((await send(id, b.token, "残った")).status).toBe(201);
		expect(await cb.next()).toMatchObject({ type: "message", body: "残った" });
	});
});
