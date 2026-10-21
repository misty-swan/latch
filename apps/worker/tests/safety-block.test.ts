/**
 * ブロックのAPI(POST/DELETE /v1/users/{user_id}/block・GET /v1/blocks)と即時効果の統合試験
 * (F7a設計 §0.3の2・3・§2.1〜§2.3)。登録は実フロー(auth/token→POST /v1/users)、
 * LATCH・membersは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import type { BlockListResponse, LatchStatus } from "@latch/shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	blocks,
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
	proposalHistory,
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

/**
 * 参加者全員のつながりLATCHを配置する。matchedOnce=trueなら成立の状態記録(to_status=matched)も置く
 * (matched経由のcancelledの判定に使う・docs/05 §3.3)。candidateは提示前(proposed_at=null)
 */
const seedLatch = async (
	accounts: Account[],
	status: LatchStatus,
	options: { min?: number; matchedOnce?: boolean } = {},
): Promise<string> => {
	const min = options.min ?? 2;
	const matchedOnce =
		options.matchedOnce ?? (status === "matched" || status === "completed");
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
		proposedAt: status === "candidate" ? null : now,
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(latchMembers)
		.values(accounts.map((acc) => ({ latchId: id, userId: acc.id })));
	if (matchedOnce) {
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

/** このLATCHのために新規に確保した提案履歴(outcome=proposed)を置く */
const seedHistory = async (latchId: string, x: string, y: string) => {
	const [low, high] = x < y ? [x, y] : [y, x];
	await db.insert(proposalHistory).values({
		id: ulid(),
		userLow: low,
		userHigh: high,
		latchId,
		outcome: "proposed",
		createdAt: new Date(Date.now() + 1000),
		updatedAt: new Date(),
	});
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

const closedNotificationsOf = async (latchId: string) =>
	db
		.select({ userId: notifications.userId })
		.from(notifications)
		.where(
			and(eq(notifications.latchId, latchId), eq(notifications.type, "closed")),
		);

const block = (targetId: string, token: string) =>
	call("POST", `/v1/users/${targetId}/block`, token);
const unblock = (targetId: string, token: string) =>
	call("DELETE", `/v1/users/${targetId}/block`, token);

const blockRowsOf = async (blockerId: string) =>
	db.select().from(blocks).where(eq(blocks.blockerUserId, blockerId));

describe("POST /v1/users/:user_id/block の対象(F7a設計 §2.1)", () => {
	it("自分自身は400 VALIDATION_FAILED(self_block)", async () => {
		const a = await registerUser("甲");
		const res = await block(a.id, a.token);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; details: { reasons?: string[] } };
		};
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["self_block"]);
		expect(await blockRowsOf(a.id)).toHaveLength(0);
	});

	it("成立前の提案だけを共有する相手・存在しないid・deletedの相手・成立なしのcancelledは404", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		await seedLatch([a, b], "proposed");
		expect((await block(b.id, a.token)).status).toBe(404);
		expect((await block(ulid(), a.token)).status).toBe(404);

		const c = await registerUser("丙");
		await seedLatch([a, c], "cancelled", { matchedOnce: false });
		expect((await block(c.id, a.token)).status).toBe(404);

		const d = await registerUser("丁");
		await seedLatch([a, d], "matched");
		await db.update(users).set({ status: "deleted" }).where(eq(users.id, d.id));
		expect((await block(d.id, a.token)).status).toBe(404);
		expect(await blockRowsOf(a.id)).toHaveLength(0);
	});

	it("matched・completed・matched経由のcancelledを共有する相手は201", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const d = await registerUser("丁");
		await seedLatch([a, b], "matched");
		await seedLatch([a, c], "completed");
		await seedLatch([a, d], "cancelled", { matchedOnce: true });
		for (const t of [b, c, d]) {
			const res = await block(t.id, a.token);
			expect(res.status).toBe(201);
			expect(await res.text()).toBe("");
		}
		expect(await blockRowsOf(a.id)).toHaveLength(3);
	});
});

describe("ブロックの即時効果(F7a設計 §2.2)", () => {
	/** A・Bが成立したうえで、2人を含む進行中の提案を3件と無関係の提案1件を置く */
	const openProposals = async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const d = await registerUser("丁");
		const e = await registerUser("戊");
		const matched = await seedLatch([a, b], "matched");
		const proposed = await seedLatch([a, b], "proposed");
		await seedHistory(proposed, a.id, b.id);
		const candidate = await seedLatch([a, b], "candidate");
		const partial = await seedLatch([a, b, d], "partial_accept");
		await seedHistory(partial, a.id, d.id);
		await seedHistory(partial, b.id, d.id);
		const unrelated = await seedLatch([a, e], "proposed");
		return { a, b, d, matched, proposed, candidate, partial, unrelated };
	};

	const expectOpenProposalsCancelled = async (
		s: Awaited<ReturnType<typeof openProposals>>,
	) => {
		expect(await statusOf(s.proposed)).toBe("cancelled");
		expect(await statusOf(s.candidate)).toBe("cancelled");
		expect(await statusOf(s.partial)).toBe("cancelled");
		expect(await statusOf(s.unrelated)).toBe("proposed");
		// 提案履歴は消費しない(新規確保の行は削除・F7a設計 §2.2の1)
		const history = await db
			.select()
			.from(proposalHistory)
			.where(inArray(proposalHistory.latchId, [s.proposed, s.partial]));
		expect(history).toHaveLength(0);
		// 提示済みだった提案の第三者にはclosedが届き、提示前の提案では作らない
		expect(
			(await closedNotificationsOf(s.partial)).map((n) => n.userId),
		).toContain(s.d.id);
		expect(await closedNotificationsOf(s.candidate)).toHaveLength(0);
	};

	it("②2人を含む進行中の提案(proposed・candidate・3人のpartial_accept)をcancelledにする", async () => {
		const s = await openProposals();
		expect((await block(s.b.id, s.a.token)).status).toBe(201);
		await expectOpenProposalsCancelled(s);
	});

	it("③1対1のmatchedはcancelled・両者のleft_atはnull・ブロックされた側は単一取得と履歴を読める", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const id = await seedLatch([a, b], "matched");
		expect((await block(b.id, a.token)).status).toBe(201);
		expect(await statusOf(id)).toBe("cancelled");
		expect((await memberOf(id, a.id))?.leftAt).toBeNull();
		expect((await memberOf(id, b.id))?.leftAt).toBeNull();
		const got = await call("GET", `/v1/latches/${id}`, b.token);
		expect(got.status).toBe(200);
		expect(((await got.json()) as { status: string }).status).toBe("cancelled");
		expect(
			(await call("GET", `/v1/latches/${id}/messages`, b.token)).status,
		).toBe(200);
	});

	it("④3人matched(min=2)でCをブロックしたAだけが抜け、min=3なら全体cancelled", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const id2 = await seedLatch([a, b, c], "matched", { min: 2 });
		const id3 = await seedLatch([a, b, c], "matched", { min: 3 });
		expect((await block(c.id, a.token)).status).toBe(201);
		expect(await statusOf(id2)).toBe("matched");
		expect((await memberOf(id2, a.id))?.leftAt).not.toBeNull();
		expect((await memberOf(id2, b.id))?.leftAt).toBeNull();
		expect((await memberOf(id2, c.id))?.leftAt).toBeNull();
		expect(await statusOf(id3)).toBe("cancelled");
	});

	it("⑤3人matchedでCが既に抜けていれば、AがCをブロックしてもAは抜けない", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const id = await seedLatch([a, b, c], "matched", { min: 2 });
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, c.token)).status,
		).toBe(200);
		expect((await block(c.id, a.token)).status).toBe(201);
		expect(await statusOf(id)).toBe("matched");
		expect((await memberOf(id, a.id))?.leftAt).toBeNull();
	});

	it("⑥completedを共有する相手のブロックではLATCHの状態・left_atは変わらない", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const id = await seedLatch([a, b], "completed");
		expect((await block(b.id, a.token)).status).toBe(201);
		expect(await statusOf(id)).toBe("completed");
		expect((await memberOf(id, a.id))?.leftAt).toBeNull();
		expect((await memberOf(id, b.id))?.leftAt).toBeNull();
	});

	it("⑧blocks行だけがある再送は200で、進行中の提案の取り消しと離脱を適用する", async () => {
		const s = await openProposals();
		await db.insert(blocks).values({
			blockerUserId: s.a.id,
			blockedUserId: s.b.id,
			createdAt: new Date(),
		});
		const res = await block(s.b.id, s.a.token);
		expect(res.status).toBe(200);
		await expectOpenProposalsCancelled(s);
		expect(await statusOf(s.matched)).toBe("cancelled");
		expect(await blockRowsOf(s.a.id)).toHaveLength(1);
	});
});

describe("GET /v1/blocks・DELETE /v1/users/:user_id/block(F7a設計 §2.1・§2.3)", () => {
	it("⑦一覧は新しい順で退会済みは「つながっていた相手」、解除は冪等で行が消える", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		await seedLatch([a, b], "completed");
		await seedLatch([a, c], "completed");
		expect((await block(b.id, a.token)).status).toBe(201);
		expect((await block(c.id, a.token)).status).toBe(201);
		// 並びを確かめるため作成時刻をずらす(Bが古い)
		const base = Date.now();
		await db
			.update(blocks)
			.set({ createdAt: new Date(base - 60_000) })
			.where(eq(blocks.blockedUserId, b.id));
		await db
			.update(blocks)
			.set({ createdAt: new Date(base) })
			.where(eq(blocks.blockedUserId, c.id));
		await db.update(users).set({ status: "deleted" }).where(eq(users.id, c.id));

		const res = await call("GET", "/v1/blocks", a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as BlockListResponse;
		expect(body.blocks.map((x) => x.user_id)).toEqual([c.id, b.id]);
		expect(body.blocks[0]?.display_name).toBe("つながっていた相手");
		expect(body.blocks[0]?.has_icon).toBe(false);
		expect(body.blocks[1]?.display_name).toBe("乙さん");
		expect(body.blocks[1]?.created_at).toBe(
			new Date(base - 60_000).toISOString(),
		);

		expect((await unblock(b.id, a.token)).status).toBe(204);
		expect((await unblock(b.id, a.token)).status).toBe(204);
		const rows = await blockRowsOf(a.id);
		expect(rows.map((r) => r.blockedUserId)).toEqual([c.id]);
		// 対象の判定を行わないため、ブロックしていない相手の解除も204
		expect((await unblock(ulid(), a.token)).status).toBe(204);
	});

	it("トークンなしは401", async () => {
		expect((await call("GET", "/v1/blocks", undefined)).status).toBe(401);
		expect((await block(ulid(), "")).status).toBe(401);
	});
});
