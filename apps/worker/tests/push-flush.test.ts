/**
 * 入口での送出の統合試験(F7b設計 §5.1)。
 * 変更系API(POST・PATCH・DELETEで2xx)の後と、主キューのバッチの後にだけ
 * waitUntilでflushPushが走る。waitUntilはcreateExecutionContext+waitOnExecutionContextで
 * 決定的に待つ。
 */
import {
	createExecutionContext,
	createMessageBatch,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import type { MatchQueueMessage } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { fixedClock } from "../src/clock/clock";
import {
	intents,
	latches,
	latchMembers,
	notifications,
	proposalHistory,
	pushSubscriptions,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import worker from "../src/index";
import { handleQueueBatch } from "../src/pipeline/consumer";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const HOUR = 60 * 60_000;

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

/** 入口(default export)を直接呼び、waitUntilの完了まで待つ */
const fetchAndWait = async (
	method: string,
	path: string,
	token: string | undefined,
	body?: unknown,
): Promise<Response> => {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://localhost${path}`, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
};

interface Account {
	token: string;
	id: string;
}

const registerUser = async (label: string): Promise<Account> => {
	const tokenRes = await fetchAndWait("POST", "/v1/auth/token", undefined, {
		provider: "google",
		idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
	});
	const pre = (await tokenRes.json()) as { access_token: string };
	const regRes = await fetchAndWait("POST", "/v1/users", pre.access_token, {
		display_name: `${label}さん`,
		birth_date: "1990-01-01",
	});
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { token: body.access_token, id: body.user.id };
};

const insertIntent = async (userId: string): Promise<string> => {
	const id = ulid();
	const now = new Date();
	await db.insert(intents).values({
		id,
		userId,
		form: "connection",
		topic: "送出の主題",
		category: null,
		rawText: "送出試験用",
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

const seedProposed = async (a: Account, b: Account): Promise<string> => {
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
		status: "proposed",
		responseDeadline: new Date(now.getTime() + HOUR),
		expiresAt: new Date(now.getTime() + 24 * HOUR),
		lastMessageAt: now,
		completedAt: null,
		proposedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(latchMembers).values([
		{ latchId: id, userId: a.id },
		{ latchId: id, userId: b.id },
	]);
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
	return id;
};

const subscribe = async (userId: string): Promise<void> => {
	await db.insert(pushSubscriptions).values({
		id: ulid(),
		userId,
		endpoint: `https://fcm.googleapis.com/fcm/send/${ulid()}`,
		p256dh: "p",
		auth: "a",
		status: "active",
		lastSuccessAt: null,
		createdAt: new Date(),
	});
};

const pushStateOf = async (userId: string) => {
	const rows = await db
		.select({ s: notifications.pushState, t: notifications.type })
		.from(notifications)
		.where(eq(notifications.userId, userId));
	return rows.filter((r) => r.t === "matched").map((r) => r.s);
};

describe("変更系APIの後の送出", () => {
	it("POST /response(yes)で成立すると、matched行が送出される", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const id = await seedProposed(a, b);
		await subscribe(a.id);
		const r1 = await fetchAndWait(
			"POST",
			`/v1/latches/${id}/response`,
			a.token,
			{
				response: "yes",
			},
		);
		expect(r1.status).toBe(200);
		const r2 = await fetchAndWait(
			"POST",
			`/v1/latches/${id}/response`,
			b.token,
			{
				response: "yes",
			},
		);
		expect(r2.status).toBe(200);
		expect(await pushStateOf(a.id)).toEqual(["sent"]);
		expect(await pushStateOf(b.id)).toEqual(["no_subscription"]);
	});

	it("GETでは送出しない(pendingのまま)", async () => {
		const a = await registerUser("丙");
		await db.insert(notifications).values({
			id: ulid(),
			userId: a.id,
			type: "proposal",
			latchId: null,
			readAt: null,
			createdAt: new Date(Date.now() - 1000),
			intentId: null,
			pushState: "pending",
			pushAttemptedAt: null,
		});
		const res = await fetchAndWait("GET", "/v1/latches?type=matched", a.token);
		expect(res.status).toBe(200);
		const rows = await db
			.select({ s: notifications.pushState })
			.from(notifications)
			.where(eq(notifications.userId, a.id));
		expect(rows.map((r) => r.s)).toEqual(["pending"]);
	});
});

describe("主キューのバッチの後の送出", () => {
	const clock = fixedClock(new Date("2026-10-19T12:00:00.000Z"));

	const seedPending = async (userId: string): Promise<string> => {
		const id = ulid();
		await db.insert(notifications).values({
			id,
			userId,
			type: "proposal",
			latchId: null,
			readAt: null,
			createdAt: new Date(clock.now().getTime() - 5000),
			intentId: null,
			pushState: "pending",
			pushAttemptedAt: null,
		});
		return id;
	};

	const stateOf = async (id: string) =>
		(
			await db
				.select({ s: notifications.pushState })
				.from(notifications)
				.where(eq(notifications.id, id))
		)[0]?.s;

	const consume = async (queue: string) => {
		const batch = createMessageBatch<MatchQueueMessage>(queue, [
			{
				id: "m1",
				timestamp: clock.now(),
				attempts: 1,
				body: { event_id: ulid() },
			},
		]);
		const ctx = createExecutionContext();
		await handleQueueBatch(batch, testEnv, ctx, clock);
		await waitOnExecutionContext(ctx);
	};

	it("主キューの消費後にpendingが送出される", async () => {
		const a = await registerUser("丁");
		const nid = await seedPending(a.id);
		await consume("match-events");
		expect(await stateOf(nid)).toBe("no_subscription");
	});

	it("DLQの消費後は送出しない", async () => {
		const a = await registerUser("戊");
		const nid = await seedPending(a.id);
		await consume("match-events-dlq");
		expect(await stateOf(nid)).toBe("pending");
	});
});
