/**
 * アプリ内通知のAPI(GET /v1/notifications・POST /v1/notifications/read)の統合試験(F7b設計 §3)。
 * 登録は実フロー、LATCH・members・intents・notificationsは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import { notificationListResponseSchema } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	intents,
	latches,
	latchMembers,
	notifications,
	users,
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
		topic: "ブロック試験の主題",
		category: null,
		rawText: "ブロック試験用",
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

const seedLatch = async (accounts: Account[]): Promise<string> => {
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
			participants: { min: 2, max: 4 },
			budget: null,
		},
		score: 0.9,
		status: "matched",
		responseDeadline: new Date(now.getTime() + HOUR),
		expiresAt: new Date(now.getTime() + 24 * HOUR),
		lastMessageAt: now,
		completedAt: null,
		proposedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(latchMembers)
		.values(accounts.map((acc) => ({ latchId: id, userId: acc.id })));
	return id;
};

const seedNotification = async (
	userId: string,
	type: "proposal" | "matched" | "closed" | "intent_expired" | "system",
	ref: { latchId?: string; intentId?: string } = {},
	id: string = ulid(),
): Promise<string> => {
	await db.insert(notifications).values({
		id,
		userId,
		type,
		latchId: ref.latchId ?? null,
		intentId: ref.intentId ?? null,
		readAt: null,
		createdAt: new Date(),
		pushState: "none",
	});
	return id;
};

interface ListBody {
	items: Array<Record<string, unknown> & { id: string; type: string }>;
	next_cursor: string | null;
	unread_count: number;
}

const list = async (token: string, query = ""): Promise<ListBody> => {
	const res = await call("GET", `/v1/notifications${query}`, token);
	expect(res.status).toBe(200);
	const body = (await res.json()) as ListBody;
	notificationListResponseSchema.parse(body);
	return body;
};

describe("GET /v1/notifications", () => {
	it("4種別がそれぞれの欄だけを持ち、push_stateを含まない", async () => {
		const me = await registerUser("me");
		const other = await registerUser("other");
		const gone = await registerUser("gone");
		await db
			.update(users)
			.set({ status: "deleted" })
			.where(eq(users.id, gone.id));
		const proposalLatch = await seedLatch([me, other]);
		const matchedLatch = await seedLatch([me, other, gone]);
		const closedLatch = await seedLatch([me, other]);
		const intentId = await insertIntent(me.id);
		await seedNotification(me.id, "proposal", { latchId: proposalLatch });
		await seedNotification(me.id, "matched", { latchId: matchedLatch });
		await seedNotification(me.id, "closed", { latchId: closedLatch });
		await seedNotification(me.id, "intent_expired", { intentId });

		const body = await list(me.token);
		expect(body.items).toHaveLength(4);
		expect(body.unread_count).toBe(4);
		const byType = Object.fromEntries(body.items.map((i) => [i.type, i]));
		const common = ["id", "type", "read_at", "created_at"];
		expect(Object.keys(byType.proposal ?? {}).sort()).toEqual(
			[...common, "latch_id", "response_deadline"].sort(),
		);
		expect(Object.keys(byType.matched ?? {}).sort()).toEqual(
			[...common, "latch_id", "display_names"].sort(),
		);
		expect(Object.keys(byType.closed ?? {}).sort()).toEqual(
			[...common, "latch_id"].sort(),
		);
		expect(Object.keys(byType.intent_expired ?? {}).sort()).toEqual(
			[...common, "intent"].sort(),
		);
		const [latchRow] = await db
			.select()
			.from(latches)
			.where(eq(latches.id, proposalLatch));
		expect(byType.proposal?.response_deadline).toBe(
			latchRow?.responseDeadline.toISOString(),
		);
		expect(((byType.matched?.display_names ?? []) as string[]).sort()).toEqual(
			["つながっていた相手", "otherさん"].sort(),
		);
		expect(byType.intent_expired?.intent).toEqual({
			id: intentId,
			raw_text: "ブロック試験用",
		});
		expect(JSON.stringify(body)).not.toContain("push_state");
	});

	it("25件は1頁目20件+next_cursor、2頁目5件+nullでid降順", async () => {
		const me = await registerUser("page");
		const ids: string[] = [];
		for (let i = 0; i < 25; i++) {
			const intentId = await insertIntent(me.id);
			ids.push(await seedNotification(me.id, "intent_expired", { intentId }));
		}
		const p1 = await list(me.token);
		expect(p1.items).toHaveLength(20);
		expect(p1.next_cursor).not.toBeNull();
		expect(p1.unread_count).toBe(25);
		const p2 = await list(
			me.token,
			`?cursor=${encodeURIComponent(p1.next_cursor ?? "")}`,
		);
		expect(p2.items).toHaveLength(5);
		expect(p2.next_cursor).toBeNull();
		const all = [...p1.items, ...p2.items].map((i) => i.id);
		expect(all).toEqual([...ids].sort().reverse());
		const bad = await call("GET", "/v1/notifications?cursor=!!", me.token);
		expect(bad.status).toBe(400);
	});

	it("left_at・hidden_atのLATCHの通知は一覧・未読数から外れ、全体cancelledでも残る参加者には出る", async () => {
		const me = await registerUser("vis");
		const other = await registerUser("vis-o");
		const left = await seedLatch([me, other]);
		const hidden = await seedLatch([me, other]);
		const cancelled = await seedLatch([me, other]);
		await db
			.update(latchMembers)
			.set({ leftAt: new Date() })
			.where(
				and(eq(latchMembers.latchId, left), eq(latchMembers.userId, me.id)),
			);
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(
				and(eq(latchMembers.latchId, hidden), eq(latchMembers.userId, me.id)),
			);
		// 相手が抜けて全体cancelledになった1対1: 自分の行は残る
		await db
			.update(latchMembers)
			.set({ leftAt: new Date() })
			.where(
				and(
					eq(latchMembers.latchId, cancelled),
					eq(latchMembers.userId, other.id),
				),
			);
		await db
			.update(latches)
			.set({ status: "cancelled" })
			.where(eq(latches.id, cancelled));
		await seedNotification(me.id, "closed", { latchId: left });
		await seedNotification(me.id, "closed", { latchId: hidden });
		const keep = await seedNotification(me.id, "closed", {
			latchId: cancelled,
		});
		const body = await list(me.token);
		expect(body.items.map((i) => i.id)).toEqual([keep]);
		expect(body.unread_count).toBe(1);
	});

	it("systemの行と他人の通知は出ない", async () => {
		const me = await registerUser("sys");
		const other = await registerUser("sys-o");
		await seedNotification(me.id, "system");
		const latch = await seedLatch([other, await registerUser("sys-x")]);
		await seedNotification(other.id, "closed", { latchId: latch });
		const body = await list(me.token);
		expect(body.items).toEqual([]);
		expect(body.unread_count).toBe(0);
		expect((await call("GET", "/v1/notifications", undefined)).status).toBe(
			401,
		);
	});
});

describe("POST /v1/notifications/read", () => {
	it("id≤up_to_idの本人の未読だけを既読にし、再送も204、他人の行は変えない", async () => {
		const me = await registerUser("read");
		const other = await registerUser("read-o");
		const mine: string[] = [];
		for (let i = 0; i < 3; i++) {
			const intentId = await insertIntent(me.id);
			mine.push(await seedNotification(me.id, "intent_expired", { intentId }));
		}
		mine.sort();
		const otherIntent = await insertIntent(other.id);
		const otherNote = await seedNotification(other.id, "intent_expired", {
			intentId: otherIntent,
		});
		const upTo = mine[1] as string;
		const res = await call("POST", "/v1/notifications/read", me.token, {
			up_to_id: upTo,
		});
		expect(res.status).toBe(204);
		const body = await list(me.token);
		const readIds = body.items
			.filter((i) => i.read_at !== null)
			.map((i) => i.id);
		expect(readIds.sort()).toEqual([mine[0], mine[1]]);
		expect(body.unread_count).toBe(1);
		const again = await call("POST", "/v1/notifications/read", me.token, {
			up_to_id: upTo,
		});
		expect(again.status).toBe(204);
		// 他人の行へ届く大きいidを渡しても他人の行は変わらない
		await call("POST", "/v1/notifications/read", me.token, {
			up_to_id: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
		});
		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, otherNote));
		expect(row?.readAt).toBeNull();
		expect((await list(me.token)).unread_count).toBe(0);
	});

	it("不正な形は400", async () => {
		const me = await registerUser("read-bad");
		for (const body of [
			{},
			{ up_to_id: "short" },
			{ up_to_id: 1 },
			{ up_to_id: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ", x: 1 },
		]) {
			const res = await call("POST", "/v1/notifications/read", me.token, body);
			expect(res.status).toBe(400);
		}
		const res = await SELF.fetch("https://localhost/v1/notifications/read", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${me.token}`,
			},
			body: "{",
		});
		expect(res.status).toBe(400);
	});
});
