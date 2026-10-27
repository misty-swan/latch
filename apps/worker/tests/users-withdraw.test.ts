/**
 * 退会(DELETE /v1/users/me・docs/05 §2.5・§3.3)の統合試験。
 * 再認証の拒否・削除の範囲(消すもの/残すもの)・相手の側の見え方(1対1は終了・グループは本人だけが抜ける・
 * 終了後のLATCHは名前を出さない)・外部の削除の失敗での中断・再登録を確かめる。
 * 登録は実フロー(auth/token→POST /v1/users)、LATCH・候補・通知などは直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import type { LatchDTO, LatchStatus } from "@latch/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	blocks,
	groupCandidates,
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	matchCandidates,
	matchEvents,
	messages,
	notifications,
	proposalHistory,
	pushSubscriptions,
	refreshFamilies,
	reports,
	sessions,
	usageCounters,
	users,
} from "../src/db/schema";
import { memoryVectorStore } from "../src/vectorstore/memory";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";
import { resetVectorState } from "./reset-vector-state";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

/** テスト鍵のIdPトークン。issuedAgoSecで発行時刻を過去へずらす */
const signIdpToken = async (
	subject: string,
	issuedAgoSec = 0,
): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now - issuedAgoSec)
		.setExpirationTime(now + 3600)
		.sign((await importJWK(privateJwk, "RS256")) as CryptoKey);
};

const HOUR = 60 * 60_000;

interface Account {
	token: string;
	refreshToken: string;
	id: string;
	subject: string;
}

/** 実フローで登録し、トークンとユーザーIDを返す */
const registerUser = async (label: string): Promise<Account> => {
	const subject = `${label}-${crypto.randomUUID()}`;
	const tokenRes = await SELF.fetch("https://localhost/v1/auth/token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "google",
			idp_token: await signIdpToken(subject),
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
			bio: `${label}のひとこと`,
			birth_date: "1990-01-01",
		}),
	});
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
		refresh_token: string;
	};
	return {
		token: body.access_token,
		refreshToken: body.refresh_token,
		id: body.user.id,
		subject,
	};
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

/** 退会の要求(本人のsubjectで今発行したIdPトークンを添える) */
const withdraw = async (acc: Account, idpToken?: string): Promise<Response> =>
	call("DELETE", "/v1/users/me", acc.token, {
		provider: "google",
		idp_token: idpToken ?? (await signIdpToken(acc.subject)),
	});

const insertIntent = async (
	userId: string,
	status: "active" | "draft" = "active",
): Promise<string> => {
	const id = ulid();
	const now = new Date();
	await db.insert(intents).values({
		id,
		userId,
		form: "connection",
		topic: "退会試験の主題",
		category: null,
		rawText: "退会試験用の本文",
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
		status,
		version: 1,
		expiresAt: new Date(now.getTime() + 30 * 24 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		jevHeldAt: null,
		jevHeldReason: null,
		jevHeldCount: 0,
		createdAt: now,
		updatedAt: now,
	});
	return id;
};

/** 参加者全員のつながりLATCHを配置する。成立を経たもの(matched・completed)は成立の状態記録も置く */
const seedLatch = async (
	accounts: Account[],
	status: LatchStatus,
	options: { min?: number; intentIds?: string[] } = {},
): Promise<string> => {
	const intentIds =
		options.intentIds ??
		(await Promise.all(accounts.map((acc) => insertIntent(acc.id))));
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
			participants: { min: options.min ?? 2, max: 4 },
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
	if (status === "matched" || status === "completed") {
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

const statusOf = async (latchId: string) => {
	const [row] = await db
		.select({ status: latches.status })
		.from(latches)
		.where(eq(latches.id, latchId));
	return row?.status;
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

const userRow = async (id: string) => {
	const [row] = await db.select().from(users).where(eq(users.id, id));
	return row;
};

const getLatch = async (latchId: string, token: string): Promise<LatchDTO> => {
	const res = await call("GET", `/v1/latches/${latchId}`, token);
	expect(res.status).toBe(200);
	return (await res.json()) as LatchDTO;
};

afterEach(async () => {
	vi.restoreAllMocks();
	await resetVectorState();
});

describe("DELETE /v1/users/me の再認証(docs/05 §3.2・§3.3)", () => {
	it("本文が無い・形が違うときは400で、何も消さない", async () => {
		const a = await registerUser("甲");
		const res = await call("DELETE", "/v1/users/me", a.token);
		expect(res.status).toBe(400);
		expect((await userRow(a.id))?.status).toBe("active");
	});

	it("別のアカウントのトークン・10分より前に発行したトークン・不正なトークンは一律403で、何も消さない", async () => {
		const a = await registerUser("甲");
		const intentId = await insertIntent(a.id);
		const cases = [
			await signIdpToken(`他人-${crypto.randomUUID()}`),
			await signIdpToken(a.subject, 11 * 60),
			"not-a-jwt",
		];
		for (const idpToken of cases) {
			const res = await withdraw(a, idpToken);
			expect(res.status).toBe(403);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("FORBIDDEN");
		}
		expect((await userRow(a.id))?.status).toBe("active");
		const [intent] = await db
			.select({ id: intents.id })
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(intent).toBeDefined();
	});

	it("providerが登録と違えば403(appleで確かめてもgoogleのアカウントは退会しない)", async () => {
		const a = await registerUser("甲");
		const res = await call("DELETE", "/v1/users/me", a.token, {
			provider: "apple",
			idp_token: await signIdpToken(a.subject),
		});
		expect(res.status).toBe(403);
		expect((await userRow(a.id))?.status).toBe("active");
	});
});

describe("退会で消すもの(docs/05 §2.5の「ユーザー退会時」の列)", () => {
	it("Intent・ベクトル・候補・イベント・提案履歴・通知・購読・セッション・カウンタ・アイコンを消し、users行はdeletedにして名前とひとことを消す", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const activeId = await insertIntent(a.id);
		const draftId = await insertIntent(a.id, "draft");
		const bIntent = await insertIntent(b.id);
		const cIntent = await insertIntent(c.id);
		const now = new Date();
		await memoryVectorStore().upsert(
			[activeId, bIntent].map((id) => ({
				id,
				values: [1, 0, 0],
				metadata: {
					form: "connection",
					status: "active",
					category: null,
					user_id: id === activeId ? a.id : b.id,
				},
			})),
		);
		const [low, high] =
			activeId < bIntent ? [activeId, bIntent] : [bIntent, activeId];
		await db.insert(matchCandidates).values({
			id: ulid(),
			intentAId: low,
			intentBId: high,
			intentAVersion: 1,
			intentBVersion: 1,
			form: "connection",
			retrievalScore: 0.9,
			cheapJudgeScore: null,
			jevResult: null,
			latchScore: null,
			prevLatchScore: null,
			status: "candidate",
			createdAt: now,
			updatedAt: now,
		});
		const groupKey = [activeId, bIntent, cIntent]
			.sort()
			.map((id) => `${id}@1`)
			.join(",");
		await db.insert(groupCandidates).values({
			id: ulid(),
			intentIds: [activeId, bIntent, cIntent].sort(),
			dedupKey: groupKey,
			aggregateScore: 0.8,
			prevAggregateScore: null,
			status: "candidate",
			createdAt: now,
		});
		await db.insert(matchEvents).values({
			id: ulid(),
			eventType: "intent_created",
			sourceIntentId: activeId,
			version: 1,
			payload: {},
			status: "processed",
			createdAt: now,
			processedAt: now,
		});
		const [ab] = a.id < b.id ? [[a.id, b.id]] : [[b.id, a.id]];
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: ab[0] as string,
			userHigh: ab[1] as string,
			latchId: null,
			outcome: "rejected",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(notifications).values({
			id: ulid(),
			userId: a.id,
			type: "intent_expired",
			latchId: null,
			readAt: null,
			createdAt: now,
			intentId: draftId,
		});
		await db.insert(pushSubscriptions).values({
			id: ulid(),
			userId: a.id,
			endpoint: `https://push.example/${crypto.randomUUID()}`,
			p256dh: "p256dh",
			auth: "auth",
			status: "active",
			lastSuccessAt: null,
			createdAt: now,
		});
		await db
			.insert(sessions)
			.values({ id: ulid(), userId: a.id, startedAt: now });
		await db.insert(usageCounters).values({
			scope: "intent_daily",
			key: a.id,
			period: "2026-10-26",
			count: 3,
		});
		const iconKey = `icons/${a.id}/${crypto.randomUUID()}`;
		await testEnv.ICONS.put(iconKey, new Uint8Array([1, 2, 3]));
		await db.update(users).set({ iconKey }).where(eq(users.id, a.id));

		const res = await withdraw(a);
		expect(res.status).toBe(204);

		const user = await userRow(a.id);
		expect(user?.status).toBe("deleted");
		expect(user?.displayName).toBe("");
		expect(user?.bio).toBe("");
		expect(user?.iconKey).toBeNull();
		expect(await testEnv.ICONS.head(iconKey)).toBeNull();
		expect(
			await db.select().from(intents).where(eq(intents.userId, a.id)),
		).toHaveLength(0);
		expect(await memoryVectorStore().getByIds([activeId, bIntent])).toEqual([
			null,
			expect.objectContaining({ id: bIntent }),
		]);
		expect(
			await db
				.select()
				.from(matchCandidates)
				.where(
					or(
						eq(matchCandidates.intentAId, activeId),
						eq(matchCandidates.intentBId, activeId),
					),
				),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(groupCandidates)
				.where(eq(groupCandidates.dedupKey, groupKey)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(matchEvents)
				.where(eq(matchEvents.sourceIntentId, activeId)),
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(proposalHistory)
				.where(
					or(
						eq(proposalHistory.userLow, a.id),
						eq(proposalHistory.userHigh, a.id),
					),
				),
		).toHaveLength(0);
		for (const table of [notifications, pushSubscriptions, sessions]) {
			expect(
				await db.select().from(table).where(eq(table.userId, a.id)),
			).toHaveLength(0);
		}
		expect(
			await db.select().from(usageCounters).where(eq(usageCounters.key, a.id)),
		).toHaveLength(0);
		// 相手の意思は残る
		expect(
			await db
				.select({ id: intents.id })
				.from(intents)
				.where(inArray(intents.id, [bIntent, cIntent])),
		).toHaveLength(2);
	});

	it("トークンは使えなくなる: 同じアクセストークンは401・リフレッシュは401・族はrevoked", async () => {
		const a = await registerUser("甲");
		expect((await withdraw(a)).status).toBe(204);
		expect((await call("GET", "/v1/users/me", a.token)).status).toBe(401);
		const refreshRes = await call("POST", "/v1/auth/refresh", undefined, {
			refresh_token: a.refreshToken,
		});
		expect(refreshRes.status).toBe(401);
		const families = await db
			.select({ status: refreshFamilies.status })
			.from(refreshFamilies)
			.where(eq(refreshFamilies.userId, a.id));
		expect(families.length).toBeGreaterThan(0);
		expect(families.every((f) => f.status === "revoked")).toBe(true);
	});

	it("同じIdPのアカウントで入り直すと未登録として扱われ、同じ行を使って登録し直せる", async () => {
		const a = await registerUser("甲");
		expect((await withdraw(a)).status).toBe(204);
		const tokenRes = await call("POST", "/v1/auth/token", undefined, {
			provider: "google",
			idp_token: await signIdpToken(a.subject),
		});
		const body = (await tokenRes.json()) as {
			registration_required: boolean;
			access_token: string;
		};
		expect(body.registration_required).toBe(true);
		const regRes = await call("POST", "/v1/users", body.access_token, {
			display_name: "戻ってきた人",
			birth_date: "1990-01-01",
		});
		expect(regRes.status).toBe(201);
		const reg = (await regRes.json()) as { user: { id: string } };
		expect(reg.user.id).toBe(a.id);
	});
});

describe("退会で残すもの・相手の側の見え方(docs/05 §2.5・01 §10)", () => {
	it("提案中は取り消し、1対1の成立中は双方読み取り専用(cancelled)、相手には「つながっていた相手」と出る", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const proposed = await seedLatch([a, b], "proposed");
		const matched = await seedLatch([a, c], "matched");
		await db.insert(messages).values({
			id: ulid(),
			latchId: matched,
			userId: a.id,
			body: "退会する人の発言",
			createdAt: new Date(),
			clientId: null,
		});

		expect((await withdraw(a)).status).toBe(204);

		expect(await statusOf(proposed)).toBe("cancelled");
		expect(await statusOf(matched)).toBe("cancelled");
		// 相手の側: 終了したつながりとして読める。メッセージは残る
		const seen = await getLatch(matched, c.token);
		expect(seen.status).toBe("cancelled");
		expect(seen.members?.map((m) => [m.display_name, m.has_icon])).toEqual([
			["つながっていた相手", false],
		]);
		const page = await call("GET", `/v1/latches/${matched}/messages`, c.token);
		expect(page.status).toBe(200);
		const msgs = (await page.json()) as { items: { body: string }[] };
		expect(msgs.items.map((m) => m.body)).toEqual(["退会する人の発言"]);
	});

	it("グループの成立中は本人だけが抜け、残りが下限以上ならグループは続く", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const c = await registerUser("丙");
		const group = await seedLatch([a, b, c], "matched", { min: 2 });

		expect((await withdraw(a)).status).toBe(204);

		expect(await statusOf(group)).toBe("matched");
		expect((await memberOf(group, a.id))?.leftAt).not.toBeNull();
		const seen = await getLatch(group, b.token);
		expect(seen.members?.map((m) => m.user_id)).toEqual([c.id]);
	});

	it("終了後(completed)のLATCHは変えず、相手には名前・ひとこと・アイコンを出さない", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const done = await seedLatch([a, b], "completed");

		expect((await withdraw(a)).status).toBe(204);

		expect(await statusOf(done)).toBe("completed");
		const seen = await getLatch(done, b.token);
		expect(seen.members).toEqual([
			{
				user_id: a.id,
				display_name: "つながっていた相手",
				bio: "",
				has_icon: false,
			},
		]);
	});

	it("ブロックと通報の行は残す(安全のための証跡)", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const now = new Date();
		await db
			.insert(blocks)
			.values({ blockerUserId: a.id, blockedUserId: b.id, createdAt: now });
		await db.insert(reports).values({
			id: ulid(),
			reporter: b.id,
			reportee: a.id,
			reason: "spam",
			target: "profile",
			latchId: null,
			messageId: null,
			note: "",
			status: "open",
			createdAt: now,
		});

		expect((await withdraw(a)).status).toBe(204);

		expect(
			await db.select().from(blocks).where(eq(blocks.blockerUserId, a.id)),
		).toHaveLength(1);
		expect(
			await db.select().from(reports).where(eq(reports.reportee, a.id)),
		).toHaveLength(1);
	});
});

describe("外部の削除の失敗(docs/05 §2.5の実行順序)", () => {
	it("ベクトルの削除がやり直しの後も失敗したら500で中断し、D1は変えない(再試行で完了する)", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const intentId = await insertIntent(a.id);
		const proposed = await seedLatch([a, b], "proposed");
		const deleteSpy = vi
			.spyOn(memoryVectorStore(), "deleteByIds")
			.mockRejectedValue(new Error("vectorize down"));

		const res = await withdraw(a);
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"INTERNAL",
		);
		// 最初の1回と、0.5秒・1秒の待ちのやり直し2回(試験では待ち0・LAT-126)
		expect(deleteSpy).toHaveBeenCalledTimes(3);
		deleteSpy.mockRestore();
		expect((await userRow(a.id))?.status).toBe("active");
		expect(await statusOf(proposed)).toBe("proposed");
		const [intent] = await db
			.select({ id: intents.id })
			.from(intents)
			.where(eq(intents.id, intentId));
		expect(intent).toBeDefined();

		expect((await withdraw(a)).status).toBe(204);
		expect((await userRow(a.id))?.status).toBe("deleted");
	});

	it("ベクトルの削除の一時的な失敗は短いやり直しで吸収し、退会を続ける(LAT-126)", async () => {
		const a = await registerUser("甲");
		await insertIntent(a.id);
		const deleteSpy = vi
			.spyOn(memoryVectorStore(), "deleteByIds")
			.mockRejectedValueOnce(
				new Error("VECTOR_DELETE_ERROR (code = 40041): Too Many Requests"),
			);

		expect((await withdraw(a)).status).toBe(204);
		expect(deleteSpy).toHaveBeenCalledTimes(2);
		expect((await userRow(a.id))?.status).toBe("deleted");
	});

	it("書き込みの頻度の上限(VECTOR_DELETE_40041)が続けば503と「少し待って」の文言で中断する(LAT-126)", async () => {
		const a = await registerUser("甲");
		await insertIntent(a.id);
		const deleteSpy = vi
			.spyOn(memoryVectorStore(), "deleteByIds")
			.mockRejectedValue(
				new Error("VECTOR_DELETE_ERROR (code = 40041): Too Many Requests"),
			);

		const res = await withdraw(a);
		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("TEMPORARILY_UNAVAILABLE");
		expect(body.error.message).toBe(
			"退会できませんでした。少し待ってからもう一度お試しください",
		);
		expect((await userRow(a.id))?.status).toBe("active");

		// 上限が解けた後の再試行で完了する
		deleteSpy.mockRestore();
		expect((await withdraw(a)).status).toBe(204);
		expect((await userRow(a.id))?.status).toBe("deleted");
	});

	it("退会済みのアカウントの再送は404(別のアクセストークンでも)", async () => {
		const a = await registerUser("甲");
		const other = await call("POST", "/v1/auth/refresh", undefined, {
			refresh_token: a.refreshToken,
		});
		const { access_token } = (await other.json()) as { access_token: string };
		expect((await withdraw(a)).status).toBe(204);
		const again = await withdraw({ ...a, token: access_token });
		expect(again.status).toBe(404);
	});
});
