/**
 * /v1/latches APIの統合試験(F4a設計 §4.1・§4.5・#18・#20)。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得し、LATCH行は直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { monotonicFactory, ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import { markRead } from "../src/chat/messages";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	messages,
	proposalHistory,
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

type SeedStatus = "candidate" | "proposed" | "matched";

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

const setup = async (status: SeedStatus = "proposed") => {
	const a = await registerUser("甲");
	const b = await registerUser("乙");
	const id = await seedLatch(a, b, status);
	return { a, b, id };
};

const yes = (id: string, token: string) =>
	call("POST", `/v1/latches/${id}/response`, token, { response: "yes" });

describe("GET /v1/latches/:id の表示範囲", () => {
	it("成立前の応答にproposal・membersのキーが存在しない(#20)", async () => {
		const { a, id } = await setup("proposed");
		const res = await call("GET", `/v1/latches/${id}`, a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"form",
				"id",
				"matched_at",
				"my_intent_id",
				"my_response",
				"participants_count",
				"response_deadline",
				"score",
				"status",
			].sort(),
		);
		expect(body.participants_count).toBe(2);
		expect(body.my_response).toBeNull();
	});

	it("my_intent_idは自分側のIntent IDで、成立前のmatched_atはnull", async () => {
		const { a, b, id } = await setup("proposed");
		const mineOf = async (userId: string) => {
			const rows = await db
				.select({ id: intents.id })
				.from(intents)
				.where(eq(intents.userId, userId));
			return rows[0]?.id;
		};
		for (const u of [a, b]) {
			const res = await call("GET", `/v1/latches/${id}`, u.token);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.my_intent_id).toBe(await mineOf(u.id));
			expect(body.matched_at).toBeNull();
			expect(Object.keys(body).sort()).toEqual(
				[
					"id",
					"form",
					"status",
					"response_deadline",
					"participants_count",
					"my_response",
					"score",
					"my_intent_id",
					"matched_at",
				].sort(),
			);
		}
	});

	it("双方yes後のmatched_atはmatchedの状態記録の時刻", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		const [ev] = await db
			.select()
			.from(latchStatusEvents)
			.where(
				and(
					eq(latchStatusEvents.latchId, id),
					eq(latchStatusEvents.toStatus, "matched"),
				),
			);
		expect(ev).toBeDefined();
		const body = (await (
			await call("GET", `/v1/latches/${id}`, a.token)
		).json()) as { matched_at: string | null };
		expect(body.matched_at).toBe(ev?.createdAt.toISOString());
		const left = (await (
			await call("POST", `/v1/latches/${id}/leave`, a.token)
		).json()) as { status: string; matched_at: string | null };
		expect(left.status).toBe("cancelled");
		expect(left.matched_at).toBe(ev?.createdAt.toISOString());
	});

	it("自分のIntent行が削除済みでもmy_intent_idはnullで、取得・一覧・leaveは200のまま", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		await db.delete(intents).where(eq(intents.userId, a.id));
		const res = await call("GET", `/v1/latches/${id}`, a.token);
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { my_intent_id: unknown }).my_intent_id,
		).toBeNull();
		const list = await call("GET", "/v1/latches?type=matched", a.token);
		const items = ((await list.json()) as { items: { id: string }[] }).items;
		expect(items.map((i) => i.id)).toContain(id);
		const left = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(left.status).toBe(200);
	});

	it("グループでも各参加者のmy_intent_idは本人のIntent", async () => {
		const [a, b, c] = [
			await registerUser("甲"),
			await registerUser("乙"),
			await registerUser("丙"),
		];
		const ids = [await insertIntent(a.id), await insertIntent(b.id)];
		ids.push(await insertIntent(c.id));
		const id = ulid();
		const now = new Date();
		await db.insert(latches).values({
			id,
			form: "connection",
			intentIds: ids,
			proposal: {
				form: "connection",
				topic: "グループ",
				time_window: null,
				region_name: null,
				participants: { min: 3, max: 4 },
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
		await db
			.insert(latchMembers)
			.values([a, b, c].map((u) => ({ latchId: id, userId: u.id })));
		for (const [u, intentId] of [
			[a, ids[0]],
			[b, ids[1]],
			[c, ids[2]],
		] as const) {
			const body = (await (
				await call("GET", `/v1/latches/${id}`, u.token)
			).json()) as { my_intent_id: string };
			expect(body.my_intent_id).toBe(intentId);
		}
	});

	it("双方yes後はproposal.topicと相手のdisplay_nameが見え、自分は含まれない(#18・#20)", async () => {
		const { a, b, id } = await setup("proposed");
		const r1 = await yes(id, a.token);
		expect(r1.status).toBe(200);
		const mid = (await r1.json()) as Record<string, unknown>;
		expect(mid.status).toBe("partial_accept");
		expect(mid.my_response).toBe("yes");
		expect("proposal" in mid).toBe(false);
		expect("members" in mid).toBe(false);

		expect((await yes(id, b.token)).status).toBe(200);
		const res = await call("GET", `/v1/latches/${id}`, a.token);
		const body = (await res.json()) as {
			status: string;
			proposal: { topic: string };
			members: unknown[];
		};
		expect(body.status).toBe("matched");
		expect(body.proposal.topic).toBe("秘密の主題");
		expect(body.members).toEqual([
			{ user_id: b.id, display_name: "乙さん", bio: "", has_icon: false },
		]);
	});

	it("matched経由のcancelled(leave後)はproposal・membersを含む", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		const res = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			proposal?: unknown;
			members?: unknown[];
		};
		expect(body.status).toBe("cancelled");
		expect(body.proposal).toBeDefined();
		expect(body.members).toHaveLength(1);
	});

	it("completedはproposal・members・matched_atを含む(docs/02 D-08)", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		const body = (await (
			await call("GET", `/v1/latches/${id}`, a.token)
		).json()) as {
			status: string;
			proposal?: unknown;
			members?: unknown[];
			matched_at: string | null;
		};
		expect(body.status).toBe("completed");
		expect(body.proposal).toBeDefined();
		expect(body.members).toHaveLength(1);
		expect(body.matched_at).not.toBeNull();
	});

	it("completedへのleaveは400 invalid_status", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		await db
			.update(latches)
			.set({ status: "completed" })
			.where(eq(latches.id, id));
		const res = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { details: { reasons: string[] } };
		};
		expect(body.error.details.reasons).toEqual(["invalid_status"]);
	});

	it("matchedを経ないcancelledはproposal・membersを含まない", async () => {
		const { a, id } = await setup("proposed");
		await db
			.update(latches)
			.set({ status: "cancelled" })
			.where(eq(latches.id, id));
		const body = (await (
			await call("GET", `/v1/latches/${id}`, a.token)
		).json()) as Record<string, unknown>;
		expect("proposal" in body).toBe(false);
		expect("members" in body).toBe(false);
	});

	it("取り消したyesはmy_responseに出ない", async () => {
		const { a, id } = await setup("proposed");
		await yes(id, a.token);
		const res = await call(
			"POST",
			`/v1/latches/${id}/response/retract`,
			a.token,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { my_response: unknown; status: string };
		expect(body.my_response).toBeNull();
		expect(body.status).toBe("proposed");
	});

	it("第三者・存在しない・保留中(candidate)は一律404", async () => {
		const { a, id } = await setup("proposed");
		const outsider = await registerUser("丙");
		expect(
			(await call("GET", `/v1/latches/${id}`, outsider.token)).status,
		).toBe(404);
		expect((await call("GET", `/v1/latches/${ulid()}`, a.token)).status).toBe(
			404,
		);
		const held = await setup("candidate");
		expect(
			(await call("GET", `/v1/latches/${held.id}`, held.a.token)).status,
		).toBe(404);
		expect((await yes(held.id, held.a.token)).status).toBe(404);
	});
});

describe("リクエスト検証と失敗の写像", () => {
	it("未認証は401", async () => {
		const { id } = await setup("proposed");
		expect((await call("GET", `/v1/latches/${id}`, undefined)).status).toBe(
			401,
		);
	});

	it("type未指定・不正やlimit・cursor不正は400", async () => {
		const { a } = await setup("proposed");
		expect((await call("GET", "/v1/latches", a.token)).status).toBe(400);
		expect((await call("GET", "/v1/latches?type=x", a.token)).status).toBe(400);
		expect(
			(await call("GET", "/v1/latches?type=proposals&limit=0", a.token)).status,
		).toBe(400);
		expect(
			(await call("GET", "/v1/latches?type=proposals&cursor=zzz", a.token))
				.status,
		).toBe(400);
	});

	it("responseとreasonの不正値は400", async () => {
		const { a, id } = await setup("proposed");
		const res = await call("POST", `/v1/latches/${id}/response`, a.token, {
			response: "maybe",
		});
		expect(res.status).toBe(400);
		const bad = await call("POST", `/v1/latches/${id}/defer-reason`, a.token, {
			reason: "x",
		});
		expect(bad.status).toBe(400);
	});

	it("RespondFailureは400でdetails.reasonsに理由が入る", async () => {
		const { a, id } = await setup("proposed");
		await yes(id, a.token);
		const again = await yes(id, a.token);
		expect(again.status).toBe(400);
		const body = (await again.json()) as {
			error: { code: string; details: { reasons: string[] } };
		};
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details.reasons).toEqual(["already_responded"]);
		const notDeferred = await call(
			"POST",
			`/v1/latches/${id}/defer-reason`,
			a.token,
			{ reason: "no_capacity" },
		);
		expect(notDeferred.status).toBe(400);
		const nd = (await notDeferred.json()) as {
			error: { details: { reasons: string[] } };
		};
		expect(nd.error.details.reasons).toEqual(["not_deferred"]);
	});

	it("defer後にdefer-reasonを保存できる", async () => {
		const { a, id } = await setup("proposed");
		const d = await call("POST", `/v1/latches/${id}/response`, a.token, {
			response: "defer",
		});
		expect(d.status).toBe(200);
		const res = await call("POST", `/v1/latches/${id}/defer-reason`, a.token, {
			reason: "no_capacity",
		});
		expect(res.status).toBe(200);
		const [row] = await db
			.select()
			.from(latchResponses)
			.where(eq(latchResponses.latchId, id));
		expect(row?.deferReason).toBe("no_capacity");
	});

	it("yes→yesでlatch_status_eventsにmatchedが記録される", async () => {
		const { a, b, id } = await setup("proposed");
		await yes(id, a.token);
		await yes(id, b.token);
		const evs = await db
			.select()
			.from(latchStatusEvents)
			.where(eq(latchStatusEvents.latchId, id));
		expect(evs.some((e) => e.toStatus === "matched")).toBe(true);
	});
});

describe("GET /v1/latches 一覧", () => {
	it("proposalsは参加するもののみで、proposalキーを出さない", async () => {
		const p = await setup("proposed");
		const outsider = await registerUser("丁");
		const res = await call("GET", "/v1/latches?type=proposals", p.a.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
		};
		expect(body.items.map((i) => i.id)).toEqual([p.id]);
		expect("proposal" in (body.items[0] ?? {})).toBe(false);
		const other = (await (
			await call("GET", "/v1/latches?type=proposals", outsider.token)
		).json()) as { items: unknown[] };
		expect(other.items).toEqual([]);
	});

	it("candidateは一覧に出ず、matchedはtype=matchedに出る", async () => {
		const held = await setup("candidate");
		const m = await setup("matched");
		const listP = (await (
			await call("GET", "/v1/latches?type=proposals", held.a.token)
		).json()) as { items: unknown[] };
		expect(listP.items).toEqual([]);
		const listM = (await (
			await call("GET", "/v1/latches?type=matched", m.a.token)
		).json()) as { items: { id: string; members: unknown[] }[] };
		expect(listM.items.map((i) => i.id)).toEqual([m.id]);
		expect(listM.items[0]?.members).toHaveLength(1);
	});

	it("type=matchedの一覧はcompletedを含み、proposed・cancelledは含まない", async () => {
		const a = await registerUser("己");
		const ids: Record<string, string> = {};
		for (const status of ["matched", "completed", "proposed", "cancelled"]) {
			const b = await registerUser(`相手${status}`);
			ids[status] = await seedLatch(a, b, "proposed", false);
			await db
				.update(latches)
				.set({ status: status as "matched" })
				.where(eq(latches.id, ids[status]));
		}
		const list = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		const listed = list.items.map((i) => i.id);
		expect(listed).toContain(ids.matched);
		expect(listed).toContain(ids.completed);
		expect(listed).not.toContain(ids.proposed);
		expect(listed).not.toContain(ids.cancelled);
	});

	it("id降順でcursor/limitによりページングできる", async () => {
		const a = await registerUser("戊");
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const b = await registerUser(`相手${i}`);
			ids.push(await seedLatch(a, b, "proposed", false));
		}
		const expected = [...ids].sort().reverse();
		const p1 = (await (
			await call("GET", "/v1/latches?type=proposals&limit=2", a.token)
		).json()) as { items: { id: string }[]; next_cursor: string | null };
		expect(p1.items.map((i) => i.id)).toEqual(expected.slice(0, 2));
		expect(p1.next_cursor).not.toBeNull();
		const p2 = (await (
			await call(
				"GET",
				`/v1/latches?type=proposals&limit=2&cursor=${p1.next_cursor}`,
				a.token,
			)
		).json()) as { items: { id: string }[]; next_cursor: string | null };
		expect(p2.items.map((i) => i.id)).toEqual(expected.slice(2));
		expect(p2.next_cursor).toBeNull();
	});
});

/** 4人のmatchedのつながりLATCH(participants.min=3)を配置する */
const seedMatchedGroup = async (accounts: Account[]): Promise<string> => {
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
			topic: "グループの主題",
			time_window: null,
			region_name: null,
			participants: { min: 3, max: 4 },
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

describe("グループの成立後の離脱(F4b設計 §3.4・オーナー裁定3)", () => {
	it("4人(min=3)で1人leave → 残りのmembersは2人・participants_countは3、離脱者はGET 404・一覧に出ない", async () => {
		const accounts = [
			await registerUser("甲"),
			await registerUser("乙"),
			await registerUser("丙"),
			await registerUser("丁"),
		];
		const [a, b, c, d] = accounts as [Account, Account, Account, Account];
		const id = await seedMatchedGroup(accounts);

		const res = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(res.status).toBe(200);
		const left = (await res.json()) as {
			status: string;
			participants_count: number;
		};
		expect(left.status).toBe("matched");
		expect(left.participants_count).toBe(3);

		const got = (await (
			await call("GET", `/v1/latches/${id}`, b.token)
		).json()) as {
			status: string;
			participants_count: number;
			members: { user_id: string }[];
		};
		expect(got.status).toBe("matched");
		expect(got.participants_count).toBe(3);
		expect(got.members.map((m) => m.user_id).sort()).toEqual(
			[c.id, d.id].sort(),
		);

		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(404);
		const mineA = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		expect(mineA.items.map((i) => i.id)).not.toContain(id);
		const mineB = (await (
			await call("GET", "/v1/latches?type=matched", b.token)
		).json()) as { items: { id: string; participants_count: number }[] };
		expect(mineB.items.find((i) => i.id === id)?.participants_count).toBe(3);

		const res2 = await call("POST", `/v1/latches/${id}/leave`, b.token);
		expect(res2.status).toBe(200);
		expect(((await res2.json()) as { status: string }).status).toBe(
			"cancelled",
		);
	});
});

describe("成立後のLatchDTOの最終メッセージ・未読数と一覧の範囲(F6a設計 §2.3・§3.2・§3.3)", () => {
	// 同じミリ秒内の連続送信でもIDの順=送信の順になるよう単調増加で採番する(未読数の比較がIDの順による)
	const nextMessageId = monotonicFactory();
	const sendMessage = async (latchId: string, userId: string, body: string) => {
		const id = nextMessageId();
		await db.insert(messages).values({
			id,
			latchId,
			userId,
			body,
			createdAt: new Date(),
			clientId: null,
		});
		return id;
	};
	type ChatDto = {
		status: string;
		participants_count: number;
		members?: unknown[];
		last_message?: { body: string; created_at: string; user_id: string } | null;
		unread_count?: number;
	};
	const getDto = async (id: string, token: string): Promise<ChatDto> =>
		(await (await call("GET", `/v1/latches/${id}`, token)).json()) as ChatDto;

	it("成立後のDTOはlast_message(0件ならnull)とunread_countを持つ", async () => {
		const { a, b, id } = await setup("matched");
		const empty = await getDto(id, a.token);
		expect(empty.last_message).toBeNull();
		expect(empty.unread_count).toBe(0);
		await sendMessage(id, b.id, "こんにちは");
		const got = await getDto(id, a.token);
		expect(got.last_message?.body).toBe("こんにちは");
		expect(got.last_message?.user_id).toBe(b.id);
		expect(Number.isNaN(Date.parse(got.last_message?.created_at ?? ""))).toBe(
			false,
		);
		expect(got.unread_count).toBe(1);
	});

	it("成立前(proposed)のDTOにはlast_message・unread_countのキー自体が無い", async () => {
		const { a, id } = await setup("proposed");
		const dto = await getDto(id, a.token);
		expect("last_message" in dto).toBe(false);
		expect("unread_count" in dto).toBe(false);
	});

	it("未読は相手の送信だけを数え、既読記録で0になる", async () => {
		const { a, b, id } = await setup("matched");
		await sendMessage(id, a.id, "自分の送信");
		await sendMessage(id, b.id, "相手1");
		const last = await sendMessage(id, b.id, "相手2");
		expect((await getDto(id, a.token)).unread_count).toBe(2);
		expect((await getDto(id, b.token)).unread_count).toBe(1);
		await markRead(db, id, a.id, last);
		expect((await getDto(id, a.token)).unread_count).toBe(0);
	});

	it("1対1をleaveでcancelledにすると、残された側のtype=matchedに出て、離脱した本人には出ない", async () => {
		const { a, b, id } = await setup("proposed");
		expect((await yes(id, a.token)).status).toBe(200);
		expect((await yes(id, b.token)).status).toBe(200);
		const res = await call("POST", `/v1/latches/${id}/leave`, a.token);
		expect(((await res.json()) as { status: string }).status).toBe("cancelled");
		const listB = (await (
			await call("GET", "/v1/latches?type=matched", b.token)
		).json()) as { items: (ChatDto & { id: string })[] };
		const item = listB.items.find((i) => i.id === id);
		expect(item?.status).toBe("cancelled");
		expect(item?.unread_count).toBe(0);
		// 下限割れで全体を取り消した離脱でも本人のleft_atが記録され、本人の一覧から消える(docs/05 §3.3)
		const listA = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		expect(listA.items.map((i) => i.id)).not.toContain(id);
	});

	it("1対1のPOST /leaveで本人のleft_atが記録され、本人のGETは404・一覧から消え、相手の一覧ではcancelled", async () => {
		const { a, b, id } = await setup("proposed");
		expect((await yes(id, a.token)).status).toBe(200);
		expect((await yes(id, b.token)).status).toBe(200);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		const [me] = await db
			.select({ leftAt: latchMembers.leftAt })
			.from(latchMembers)
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect(me?.leftAt).not.toBeNull();
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		// 取り消した後の再試行は継続側の離脱と同じく非参加の404
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(404);
		const listA = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		expect(listA.items.map((i) => i.id)).not.toContain(id);
		const listB = (await (
			await call("GET", "/v1/latches?type=matched", b.token)
		).json()) as { items: (ChatDto & { id: string })[] };
		const item = listB.items.find((i) => i.id === id);
		expect(item?.status).toBe("cancelled");
		expect(item?.participants_count).toBe(1);
	});

	it("hidden_atを持つ本人のPOST /leaveは404で、離脱応答(includeLeft)でも本人へ返さない", async () => {
		const { a, id } = await setup("matched");
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(404);
		// 非参加の扱いのため離脱は実行されない(left_at・状態は不変)
		const [me] = await db
			.select({ leftAt: latchMembers.leftAt })
			.from(latchMembers)
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect(me?.leftAt).toBeNull();
		const [row] = await db
			.select({ status: latches.status })
			.from(latches)
			.where(eq(latches.id, id));
		expect(row?.status).toBe("matched");
	});

	it("matched経由のcancelledでもhidden_atを持つ本人の一覧には出ない", async () => {
		const { a, b, id } = await setup("proposed");
		expect((await yes(id, a.token)).status).toBe(200);
		expect((await yes(id, b.token)).status).toBe(200);
		expect(
			(await call("POST", `/v1/latches/${id}/leave`, a.token)).status,
		).toBe(200);
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, b.id)));
		const listB = (await (
			await call("GET", "/v1/latches?type=matched", b.token)
		).json()) as { items: { id: string }[] };
		expect(listB.items.map((i) => i.id)).not.toContain(id);
		expect((await call("GET", `/v1/latches/${id}`, b.token)).status).toBe(404);
	});

	it("matchedを経ないcancelledはtype=matchedに出ない", async () => {
		const { a, id } = await setup("proposed");
		await db
			.update(latches)
			.set({ status: "cancelled" })
			.where(eq(latches.id, id));
		const list = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		expect(list.items.map((i) => i.id)).not.toContain(id);
	});

	it("hidden_atを立てた本人の一覧・単一取得から消え、相手のmembers・participants_countは変わらない", async () => {
		const { a, b, id } = await setup("matched");
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect((await call("GET", `/v1/latches/${id}`, a.token)).status).toBe(404);
		const listA = (await (
			await call("GET", "/v1/latches?type=matched", a.token)
		).json()) as { items: { id: string }[] };
		expect(listA.items.map((i) => i.id)).not.toContain(id);
		const gotB = await getDto(id, b.token);
		expect(gotB.participants_count).toBe(2);
		expect(gotB.members).toHaveLength(1);
	});
});
