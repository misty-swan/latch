/**
 * 通報のAPI(POST /v1/reports)の統合試験(F7a設計 §0.3の4・§3)。
 * 登録は実フロー、LATCH・members・messagesは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
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
	latchStatusEvents,
	messages,
	reports,
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

const post = (token: string | undefined, body: unknown) =>
	call("POST", "/v1/reports", token, body);

const seedMessage = async (
	latchId: string,
	userId: string,
): Promise<string> => {
	const id = ulid();
	await db.insert(messages).values({
		id,
		latchId,
		userId,
		body: "こんにちは",
		createdAt: new Date(),
		clientId: null,
	});
	return id;
};

const rowsOf = (reporter: string, latchId: string) =>
	db
		.select()
		.from(reports)
		.where(and(eq(reports.reporter, reporter), eq(reports.latchId, latchId)));

describe("POST /v1/reports", () => {
	it("target=proposalは自分以外の全参加者ぶんの行を作り、状態は不変・応答は{received:true}だけ", async () => {
		const [a, b, c] = [
			await registerUser("ra"),
			await registerUser("rb"),
			await registerUser("rc"),
		];
		const latchId = await seedLatch([a, b, c], "proposed", { min: 3 });
		const res = await post(a.token, {
			latch_id: latchId,
			target: "proposal",
			reason: "spam",
			note: "  迷惑  ",
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ received: true });
		const rows = await rowsOf(a.id, latchId);
		expect(rows.map((r) => r.reportee).sort()).toEqual([b.id, c.id].sort());
		for (const r of rows) {
			expect(r.reason).toBe("spam");
			expect(r.note).toBe("迷惑");
			expect(r.target).toBe("proposal");
			expect(r.status).toBe("open");
			expect(r.messageId).toBeNull();
		}
		const [l] = await db.select().from(latches).where(eq(latches.id, latchId));
		expect(l?.status).toBe("proposed");
	});

	it("note未指定は空文字で保存される", async () => {
		const [a, b] = [await registerUser("rn1"), await registerUser("rn2")];
		const latchId = await seedLatch([a, b], "partial_accept");
		expect(
			(
				await post(a.token, {
					latch_id: latchId,
					target: "proposal",
					reason: "other",
				})
			).status,
		).toBe(201);
		expect((await rowsOf(a.id, latchId))[0]?.note).toBe("");
	});

	it("target=proposalはcandidate・matched・非参加のLATCHで404", async () => {
		const [a, b, x] = [
			await registerUser("rp1"),
			await registerUser("rp2"),
			await registerUser("rp3"),
		];
		const body = (latch_id: string) => ({
			latch_id,
			target: "proposal",
			reason: "spam",
		});
		const cand = await seedLatch([a, b], "candidate");
		const matched = await seedLatch([a, b], "matched");
		const other = await seedLatch([b, x], "proposed");
		for (const id of [cand, matched, other]) {
			const res = await post(a.token, body(id));
			expect(res.status).toBe(404);
		}
		expect(await rowsOf(a.id, cand)).toHaveLength(0);
	});

	it("成立後の形の誤りは400 VALIDATION_FAILEDと理由コード", async () => {
		const [a, b] = [await registerUser("rs1"), await registerUser("rs2")];
		const latchId = await seedLatch([a, b], "matched");
		const reasonsOf = async (body: Record<string, unknown>) => {
			const res = await post(a.token, {
				latch_id: latchId,
				reason: "spam",
				...body,
			});
			expect(res.status).toBe(400);
			const j = (await res.json()) as {
				error: { code: string; details: { reasons: string[] } };
			};
			expect(j.error.code).toBe("VALIDATION_FAILED");
			return j.error.details.reasons;
		};
		expect(await reasonsOf({ target: "profile" })).toContain(
			"reportee_required",
		);
		expect(await reasonsOf({ target: "icon" })).toContain("reportee_required");
		expect(
			await reasonsOf({ target: "message", reportee_user_id: b.id }),
		).toContain("message_required");
		expect(
			await reasonsOf({
				target: "profile",
				reportee_user_id: b.id,
				message_id: ulid(),
			}),
		).toContain("message_not_allowed");
		expect(
			await reasonsOf({
				target: "proposal",
				reportee_user_id: b.id,
			}),
		).toContain("reportee_not_allowed");
		expect(
			await reasonsOf({ target: "proposal", message_id: ulid() }),
		).toContain("message_not_allowed");
	});

	it("成立後のprofile・icon・messageを通報できる(completed・matched経由cancelledも)", async () => {
		const [a, b] = [await registerUser("rm1"), await registerUser("rm2")];
		const latchId = await seedLatch([a, b], "matched");
		const msg = await seedMessage(latchId, b.id);
		for (const body of [
			{ target: "profile", reportee_user_id: b.id },
			{ target: "icon", reportee_user_id: b.id },
			{ target: "message", reportee_user_id: b.id, message_id: msg },
		]) {
			const res = await post(a.token, {
				latch_id: latchId,
				reason: "harassment",
				...body,
			});
			expect(res.status).toBe(201);
		}
		const rows = await rowsOf(a.id, latchId);
		expect(rows.map((r) => r.target).sort()).toEqual([
			"icon",
			"message",
			"profile",
		]);
		expect(rows.find((r) => r.target === "message")?.messageId).toBe(msg);

		const done = await seedLatch([a, b], "completed");
		expect(
			(
				await post(a.token, {
					latch_id: done,
					target: "profile",
					reason: "other",
					reportee_user_id: b.id,
				})
			).status,
		).toBe(201);
		const cancelledAfterMatch = await seedLatch([a, b], "cancelled", {
			matchedOnce: true,
		});
		expect(
			(
				await post(a.token, {
					latch_id: cancelledAfterMatch,
					target: "profile",
					reason: "other",
					reportee_user_id: b.id,
				})
			).status,
		).toBe(201);
		const cancelledBefore = await seedLatch([a, b], "cancelled", {
			matchedOnce: false,
		});
		expect(
			(
				await post(a.token, {
					latch_id: cancelledBefore,
					target: "profile",
					reason: "other",
					reportee_user_id: b.id,
				})
			).status,
		).toBe(404);
	});

	it("離脱済みの本人・自分自身・非メンバー・別人/別LATCHの発言は404", async () => {
		const [a, b, x] = [
			await registerUser("rf1"),
			await registerUser("rf2"),
			await registerUser("rf3"),
		];
		const latchId = await seedLatch([a, b], "matched");
		const otherLatch = await seedLatch([a, b], "matched");
		const mine = await seedMessage(latchId, a.id);
		const inOther = await seedMessage(otherLatch, b.id);
		const send = (body: Record<string, unknown>, token = a.token) =>
			post(token, { latch_id: latchId, reason: "spam", ...body });
		expect(
			(await send({ target: "profile", reportee_user_id: a.id })).status,
		).toBe(404);
		expect(
			(await send({ target: "profile", reportee_user_id: x.id })).status,
		).toBe(404);
		expect(
			(
				await send({
					target: "message",
					reportee_user_id: b.id,
					message_id: mine,
				})
			).status,
		).toBe(404);
		expect(
			(
				await send({
					target: "message",
					reportee_user_id: b.id,
					message_id: inOther,
				})
			).status,
		).toBe(404);
		await db
			.update(latchMembers)
			.set({ leftAt: new Date() })
			.where(
				and(eq(latchMembers.latchId, latchId), eq(latchMembers.userId, a.id)),
			);
		expect(
			(await send({ target: "profile", reportee_user_id: b.id })).status,
		).toBe(404);
		expect((await rowsOf(a.id, latchId)).length).toBe(0);
	});

	it("同じ通報の再送は1行のまま上書きされ、resolved後の再送は新しい行", async () => {
		const [a, b] = [await registerUser("rd1"), await registerUser("rd2")];
		const latchId = await seedLatch([a, b], "matched");
		const body = {
			latch_id: latchId,
			target: "profile",
			reportee_user_id: b.id,
		};
		await post(a.token, { ...body, reason: "spam", note: "一回目" });
		await post(a.token, { ...body, reason: "harassment", note: "二回目" });
		let rows = await rowsOf(a.id, latchId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toBe("harassment");
		expect(rows[0]?.note).toBe("二回目");
		await db
			.update(reports)
			.set({ status: "resolved" })
			.where(eq(reports.id, rows[0]?.id as string));
		await post(a.token, { ...body, reason: "other" });
		rows = await rowsOf(a.id, latchId);
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.status === "open")).toHaveLength(1);
	});

	it("target=messageの再送は同じmessage_idなら1行のまま", async () => {
		const [a, b] = [await registerUser("rr1"), await registerUser("rr2")];
		const latchId = await seedLatch([a, b], "matched");
		const msg = await seedMessage(latchId, b.id);
		const body = {
			latch_id: latchId,
			target: "message",
			reportee_user_id: b.id,
			message_id: msg,
		};
		expect((await post(a.token, { ...body, reason: "spam" })).status).toBe(201);
		expect(
			(await post(a.token, { ...body, reason: "other", note: "再送" })).status,
		).toBe(201);
		const rows = await rowsOf(a.id, latchId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toBe("other");
		expect(rows[0]?.note).toBe("再送");
		expect(rows[0]?.messageId).toBe(msg);
	});

	it("target=proposalの再送は他の参加者ごとに1行のまま", async () => {
		const [a, b, c] = [
			await registerUser("rq1"),
			await registerUser("rq2"),
			await registerUser("rq3"),
		];
		const latchId = await seedLatch([a, b, c], "proposed", { min: 3 });
		const body = { latch_id: latchId, target: "proposal" };
		await post(a.token, { ...body, reason: "spam", note: "一回目" });
		await post(a.token, { ...body, reason: "harassment", note: "二回目" });
		const rows = await rowsOf(a.id, latchId);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.reportee).sort()).toEqual([b.id, c.id].sort());
		for (const r of rows) {
			expect(r.reason).toBe("harassment");
			expect(r.note).toBe("二回目");
		}
	});

	it("通報後も被通報者のLATCH応答に通報に関する値が無い", async () => {
		const [a, b] = [await registerUser("rv1"), await registerUser("rv2")];
		const latchId = await seedLatch([a, b], "matched");
		await post(a.token, {
			latch_id: latchId,
			target: "profile",
			reason: "spam",
			reportee_user_id: b.id,
		});
		const one = await (
			await call("GET", `/v1/latches/${latchId}`, b.token)
		).text();
		const list = await (await call("GET", "/v1/latches", b.token)).text();
		expect(one).not.toContain("report");
		expect(list).not.toContain("report");
	});

	it("未認証は401", async () => {
		const res = await post(undefined, {
			latch_id: ulid(),
			target: "proposal",
			reason: "spam",
		});
		expect(res.status).toBe(401);
	});
});
