/**
 * POST /v1/latches/{id}/feedback(正解データの自己申告・docs/01 §14・docs/05 §3.3)と
 * LatchDTO.feedback_dueの統合試験(F9)。登録は実フロー(auth/token→POST /v1/users)、
 * LATCH・members・成立の状態記録は直接INSERTで配置する。
 */
import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	latches,
	latchFeedback,
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
const DAY = 24 * HOUR;

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

type SeedStatus = "proposed" | "matched" | "completed" | "cancelled";

/**
 * 参加者全員のLATCHを配置する。proposed以外は成立の状態記録(to_status=matched)を
 * matchedAgoMs前の時刻で置く(cancelledはmatched経由の取り消し)
 */
const seedLatch = async (
	accounts: Account[],
	opts: {
		form?: "connection" | "occasion";
		status?: SeedStatus;
		matchedAgoMs?: number;
	} = {},
): Promise<string> => {
	const form = opts.form ?? "connection";
	const status = opts.status ?? "matched";
	const id = ulid();
	const now = new Date();
	const matchedAt = new Date(now.getTime() - (opts.matchedAgoMs ?? 8 * DAY));
	await db.insert(latches).values({
		id,
		form,
		intentIds: accounts.map(() => ulid()),
		proposal: {
			form,
			topic: "申告試験の主題",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 4 },
			budget: null,
		},
		score: 0.9,
		status,
		responseDeadline: new Date(matchedAt.getTime() - HOUR),
		expiresAt: new Date(now.getTime() + 24 * HOUR),
		lastMessageAt: matchedAt,
		completedAt: status === "completed" ? now : null,
		proposedAt: matchedAt,
		createdAt: matchedAt,
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
			createdAt: matchedAt,
		});
	}
	return id;
};

const pair = async (opts: Parameters<typeof seedLatch>[1] = {}) => {
	const a = await registerUser("甲");
	const b = await registerUser("乙");
	const id = await seedLatch([a, b], opts);
	return { a, b, id };
};

const feedback = (id: string, token: string | undefined, body: unknown) =>
	call("POST", `/v1/latches/${id}/feedback`, token, body);

const quality = (score: number | null) => ({
	kind: "connection_quality",
	value: { score },
});

type Dto = { id: string; feedback_due?: string | null };

const getDto = async (id: string, token: string): Promise<Dto> => {
	const res = await call("GET", `/v1/latches/${id}`, token);
	expect(res.status).toBe(200);
	return (await res.json()) as Dto;
};

const reasonsOf = async (res: Response): Promise<unknown> =>
	((await res.json()) as { error: { details: { reasons?: string[] } } }).error
		.details.reasons;

const rowsOf = (latchId: string, userId: string) =>
	db
		.select()
		.from(latchFeedback)
		.where(
			and(eq(latchFeedback.latchId, latchId), eq(latchFeedback.userId, userId)),
		);

describe("つながりの品質(connection_quality)", () => {
	it("成立から7日を過ぎると受付中になり、申告すると記録されて受付が閉じる", async () => {
		const { a, b, id } = await pair();
		expect((await getDto(id, a.token)).feedback_due).toBe("connection_quality");

		const res = await feedback(id, a.token, quality(4));
		expect(res.status).toBe(200);
		expect(((await res.json()) as Dto).feedback_due).toBeNull();

		const rows = await rowsOf(id, a.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("connection_quality");
		expect(rows[0]?.value).toEqual({ score: 4 });
		// 申告は本人ごと。相手の受付は開いたまま
		expect((await getDto(id, b.token)).feedback_due).toBe("connection_quality");
	});

	it("一覧(type=matched)にもfeedback_dueが載る", async () => {
		const { a, id } = await pair();
		const res = await call("GET", "/v1/latches?type=matched", a.token);
		const { items } = (await res.json()) as { items: Dto[] };
		expect(items.find((l) => l.id === id)?.feedback_due).toBe(
			"connection_quality",
		);
	});

	it("スキップ(score=null)も1回分として記録し、以後はたずねない", async () => {
		const { a, id } = await pair();
		const res = await feedback(id, a.token, quality(null));
		expect(res.status).toBe(200);
		expect((await rowsOf(id, a.id))[0]?.value).toEqual({ score: null });
		expect((await getDto(id, a.token)).feedback_due).toBeNull();
	});

	it("2回目はalready_respondedで断り、最初の値を残す", async () => {
		const { a, id } = await pair();
		expect((await feedback(id, a.token, quality(2))).status).toBe(200);
		const res = await feedback(id, a.token, quality(5));
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["already_responded"]);
		const rows = await rowsOf(id, a.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toEqual({ score: 2 });
	});

	it("成立から7日未満は受け付けない(invalid_status)", async () => {
		const { a, id } = await pair({ matchedAgoMs: 7 * DAY - HOUR });
		expect((await getDto(id, a.token)).feedback_due).toBeNull();
		const res = await feedback(id, a.token, quality(3));
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);
		expect(await rowsOf(id, a.id)).toHaveLength(0);
	});

	it("終了したつながり(completed・matched経由のcancelled)でも受け付ける", async () => {
		for (const status of ["completed", "cancelled"] as const) {
			const { a, id } = await pair({ status });
			expect((await getDto(id, a.token)).feedback_due).toBe(
				"connection_quality",
			);
			expect((await feedback(id, a.token, quality(1))).status).toBe(200);
		}
	});

	it("成立前(proposed)はfeedback_dueのキー自体を出さず、申告はinvalid_status", async () => {
		const { a, id } = await pair({ status: "proposed" });
		expect("feedback_due" in (await getDto(id, a.token))).toBe(false);
		const res = await feedback(id, a.token, quality(3));
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);
	});

	it("種別が形式と合わない(つながりにattendance)はkind_mismatch", async () => {
		const { a, id } = await pair();
		const res = await feedback(id, a.token, {
			kind: "attendance",
			value: { attended: true },
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["kind_mismatch"]);
	});
});

describe("機会LATCHの参加(attendance)", () => {
	it("completedになると受付中になり、参加した/しなかったを記録する", async () => {
		const { a, b, id } = await pair({ form: "occasion", status: "completed" });
		expect((await getDto(id, a.token)).feedback_due).toBe("attendance");
		const ra = await feedback(id, a.token, {
			kind: "attendance",
			value: { attended: true },
		});
		expect(ra.status).toBe(200);
		expect(((await ra.json()) as Dto).feedback_due).toBeNull();
		const rb = await feedback(id, b.token, {
			kind: "attendance",
			value: { attended: false },
		});
		expect(rb.status).toBe(200);
		expect((await rowsOf(id, a.id))[0]?.value).toEqual({ attended: true });
		expect((await rowsOf(id, b.id))[0]?.value).toEqual({ attended: false });
	});

	it("matchedのうち(対象時刻の前)は成立から7日を過ぎても受け付けない", async () => {
		const { a, id } = await pair({ form: "occasion", status: "matched" });
		expect((await getDto(id, a.token)).feedback_due).toBeNull();
		const res = await feedback(id, a.token, {
			kind: "attendance",
			value: { attended: true },
		});
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["invalid_status"]);
	});

	it("種別が形式と合わない(機会にconnection_quality)はkind_mismatch", async () => {
		const { a, id } = await pair({ form: "occasion", status: "completed" });
		const res = await feedback(id, a.token, quality(3));
		expect(res.status).toBe(400);
		expect(await reasonsOf(res)).toEqual(["kind_mismatch"]);
	});
});

describe("認可と入力の検証", () => {
	it("参加しない・存在しない・離脱した本人・表示から消した本人は一律404", async () => {
		const { a, b, id } = await pair();
		const stranger = await registerUser("丙");
		expect((await feedback(id, stranger.token, quality(3))).status).toBe(404);
		expect((await feedback(ulid(), a.token, quality(3))).status).toBe(404);

		await db
			.update(latchMembers)
			.set({ leftAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, a.id)));
		expect((await feedback(id, a.token, quality(3))).status).toBe(404);
		await db
			.update(latchMembers)
			.set({ hiddenAt: new Date() })
			.where(and(eq(latchMembers.latchId, id), eq(latchMembers.userId, b.id)));
		expect((await feedback(id, b.token, quality(3))).status).toBe(404);
		expect(await rowsOf(id, a.id)).toHaveLength(0);
		expect(await rowsOf(id, b.id)).toHaveLength(0);
	});

	it("アクセストークンなしは401", async () => {
		const { id } = await pair();
		expect((await feedback(id, undefined, quality(3))).status).toBe(401);
	});

	it.each([
		["scoreが範囲外(0)", quality(0)],
		["scoreが範囲外(6)", quality(6)],
		["scoreが整数でない", quality(3.5)],
		["scoreが文字列", { kind: "connection_quality", value: { score: "3" } }],
		["valueが無い", { kind: "connection_quality" }],
		[
			"valueに余分なキー",
			{ kind: "connection_quality", value: { score: 3, note: "x" } },
		],
		["本体に余分なキー", { ...quality(3), extra: 1 }],
		["未知のkind", { kind: "chat_quality", value: { score: 3 } }],
		[
			"attendedが論理値でない",
			{ kind: "attendance", value: { attended: "yes" } },
		],
		["本体が空", {}],
	])("%sは400 VALIDATION_FAILED", async (_label, body) => {
		const { a, id } = await pair();
		const res = await feedback(id, a.token, body);
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { code: string } };
		expect(json.error.code).toBe("VALIDATION_FAILED");
		expect(await rowsOf(id, a.id)).toHaveLength(0);
	});

	it("JSONとして読めない本体は400", async () => {
		const { a, id } = await pair();
		const res = await SELF.fetch(
			`https://localhost/v1/latches/${id}/feedback`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${a.token}`,
				},
				body: "{",
			},
		);
		expect(res.status).toBe(400);
	});
});
