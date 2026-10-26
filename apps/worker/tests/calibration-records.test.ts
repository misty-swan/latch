/**
 * 正解データ(calibration_records)の統合試験(docs/01 §14・docs/05 §2.2・§2.5・docs/08 §7・LAT-108)。
 * 行を作る契機(閉じた提案をCronが拾う)・形式ごとのActual Action・匿名化の粒度(日/月の丸め・
 * latch_idのnull化)・退会とIntent削除での匿名集約・再実行での二重作成の防止を確かめる。
 * Cronの走査は注入した時刻(固定)で呼び、退会とIntent削除は実際のAPIを通す。
 * 走査は他の試験の残置行も対象にし得るため、行はLATCHごとに違うscore(prediction.latch_score)で見分ける
 */
import { env, SELF } from "cloudflare:test";
import type { LatchStatus } from "@latch/shared";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	anonymizedTimeOf,
	createRecord,
	MIN_DAILY_POPULATION,
	runCalibrationSweep,
} from "../src/calibration/records";
import { jstDayStart, jstMonthStart } from "../src/clock/clock";
import {
	blocks,
	calibrationRecords,
	geofeatures,
	intents,
	latches,
	latchFeedback,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	matchCandidates,
	messages,
	reports,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { gridKeyOf } from "../src/latches/region";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";
import { resetVectorState } from "./reset-vector-state";

const workerEnv = env as unknown as WorkerEnv;
const db = drizzle(workerEnv.DB);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

type Form = "occasion" | "connection";

const AXES = {
	would_a_accept_b: 0.8,
	would_b_accept_a: 0.7,
	purpose_fit: 0.9,
	mood_fit: 0.6,
	timing_fit: 0.5,
	social_fit: 0.75,
	latent_yes: 0.65,
};

afterEach(async () => {
	await resetVectorState();
});

const insertUser = async (status: "active" | "deleted" = "active") => {
	const id = ulid();
	const now = new Date("2020-01-01T00:00:00Z");
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `calibration-${id}`,
		actorType: "individual",
		displayName: "正解データ試験",
		bio: "",
		birthDate: "1990-01-01",
		status,
		createdAt: now,
		updatedAt: now,
	});
	return id;
};

interface IntentOpts {
	startsAt?: Date | null;
	geo?: { lat: number; lng: number } | null;
	createdAt?: Date;
}

const insertIntent = async (
	userId: string,
	form: Form,
	opts: IntentOpts = {},
): Promise<string> => {
	const id = ulid();
	const startsAt = opts.startsAt ?? null;
	const createdAt = opts.createdAt ?? new Date("2020-01-01T00:00:00Z");
	await db.insert(intents).values({
		id,
		userId,
		form,
		topic: "正解データ試験の主題",
		category: null,
		rawText: "正解データ試験の本文",
		startsAt,
		endsAt: startsAt === null ? null : at(startsAt, 2 * HOUR),
		geoCenterLat: opts.geo?.lat ?? null,
		geoCenterLng: opts.geo?.lng ?? null,
		geoRadiusM: opts.geo === undefined || opts.geo === null ? null : 1000,
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
		expiresAt: new Date("2099-01-01T00:00:00Z"),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt,
		updatedAt: createdAt,
	});
	return id;
};

interface SeedOpts {
	form?: Form;
	status: LatchStatus;
	score: number;
	/** 提示した時刻。nullは未提示(保留のまま閉じた) */
	proposedAt: Date | null;
	/** 成立の状態記録の時刻(matched・completed・成立後のcancelled) */
	matchedAt?: Date;
	/** 機会の対象時刻 */
	startsAt?: Date;
	size?: number;
	userIds?: string[];
	intentIds?: string[];
	geo?: { lat: number; lng: number };
	/** ペアの評価の行にJevの7軸を置く */
	withJev?: boolean;
}

/** 参加者・参加Intent・LATCH・members・状態の記録(と評価の行)を配置する */
const seedLatch = async (opts: SeedOpts) => {
	const form = opts.form ?? "connection";
	const size = opts.userIds?.length ?? opts.size ?? 2;
	const userIds = opts.userIds ?? [];
	while (userIds.length < size) userIds.push(await insertUser());
	const intentIds =
		opts.intentIds ??
		(await Promise.all(
			userIds.map((u, i) =>
				insertIntent(u, form, {
					startsAt: opts.startsAt ?? null,
					// 先頭の参加者を基準Intent(最も先に預けた者)にする
					geo: i === 0 ? (opts.geo ?? null) : null,
					createdAt: new Date(Date.UTC(2020, 0, 1 + i)),
				}),
			),
		));
	const id = ulid();
	const createdAt = opts.proposedAt ?? new Date("2026-01-01T00:00:00Z");
	await db.insert(latches).values({
		id,
		form,
		intentIds,
		proposal: {
			form,
			topic: "秘密の主題",
			time_window:
				opts.startsAt === undefined
					? null
					: {
							start: opts.startsAt.toISOString(),
							end: at(opts.startsAt, 2 * HOUR).toISOString(),
						},
			region_name: opts.geo === undefined ? null : "試験駅",
			participants: { min: 2, max: 4 },
			budget: null,
		},
		score: opts.score,
		status: opts.status,
		responseDeadline: at(createdAt, DAY),
		expiresAt: at(createdAt, 60 * DAY),
		lastMessageAt: opts.matchedAt ?? createdAt,
		completedAt: null,
		proposedAt: opts.proposedAt,
		createdAt,
		updatedAt: createdAt,
	});
	await db
		.insert(latchMembers)
		.values(userIds.map((userId) => ({ latchId: id, userId })));
	if (opts.matchedAt !== undefined) {
		await db.insert(latchStatusEvents).values({
			id: ulid(),
			latchId: id,
			fromStatus: "partial_accept",
			toStatus: "matched",
			createdAt: opts.matchedAt,
		});
	}
	if (opts.withJev === true) {
		const sorted = [...intentIds].sort();
		for (let i = 0; i < sorted.length; i += 1) {
			for (let j = i + 1; j < sorted.length; j += 1) {
				await db.insert(matchCandidates).values({
					id: ulid(),
					intentAId: sorted[i],
					intentBId: sorted[j],
					intentAVersion: 1,
					intentBVersion: 1,
					form,
					retrievalScore: 0.9,
					cheapJudgeScore: 0.8,
					jevResult: { ...AXES, purpose_fit: 0.1 * (i + j) },
					latchScore: opts.score,
					prevLatchScore: null,
					status: "proposed",
					createdAt: at(createdAt, -MIN),
					updatedAt: at(createdAt, -MIN),
				});
			}
		}
	}
	return { id, userIds, intentIds };
};

/** prediction.latch_scoreで見分けた行(匿名化した行はlatch_idを持たないため) */
const recordsByScore = (score: number) =>
	db
		.select()
		.from(calibrationRecords)
		.where(
			sql`json_extract(${calibrationRecords.prediction}, '$.latch_score') = ${score}`,
		);

const calibratedAtOf = async (latchId: string) => {
	const [row] = await db
		.select({ calibratedAt: latches.calibratedAt })
		.from(latches)
		.where(eq(latches.id, latchId));
	return row?.calibratedAt ?? null;
};

describe("行を作る契機(閉じた提案をCronが拾う)", () => {
	const NOW = new Date("2026-03-10T03:00:00Z");

	it("提示した提案が閉じたら1行を作り、進行中・未提示の提案には作らない。再実行しても二重に作らない", async () => {
		const closed = await seedLatch({
			status: "rejected",
			score: 0.6101,
			proposedAt: at(NOW, -HOUR),
		});
		const open = await seedLatch({
			status: "proposed",
			score: 0.6102,
			proposedAt: at(NOW, -HOUR),
		});
		const held = await seedLatch({
			status: "cancelled",
			score: 0.6103,
			proposedAt: null,
		});

		await runCalibrationSweep(db, NOW);
		await runCalibrationSweep(db, at(NOW, MIN));
		expect(await recordsByScore(0.6101)).toHaveLength(1);
		expect(await recordsByScore(0.6102)).toHaveLength(0);
		expect(await recordsByScore(0.6103)).toHaveLength(0);
		// 未提示の提案も処理済みの印は付け、毎分の走査の対象から外す
		expect(await calibratedAtOf(closed.id)).not.toBeNull();
		expect(await calibratedAtOf(held.id)).not.toBeNull();
		expect(await calibratedAtOf(open.id)).toBeNull();

		// 印を読む前の古いLATCH(並行した実行)からの作成も、印の条件で行を作らない
		const [stale] = await db
			.select()
			.from(latches)
			.where(eq(latches.id, closed.id));
		expect(await createRecord(db, { ...stale, calibratedAt: null }, NOW)).toBe(
			false,
		);
		expect(await recordsByScore(0.6101)).toHaveLength(1);
	});

	it("結果は状態の記録で決める(rejected=one_no・expired・cancelled、成立の後のcancelledはboth_yes)", async () => {
		const cases: [LatchStatus, number, boolean, string][] = [
			["rejected", 0.6201, false, "one_no"],
			["expired", 0.6202, false, "expired"],
			["cancelled", 0.6203, false, "cancelled"],
			["cancelled", 0.6204, true, "both_yes"],
			["matched", 0.6205, true, "both_yes"],
		];
		for (const [status, score, matched] of cases) {
			await seedLatch({
				status,
				score,
				proposedAt: at(NOW, -2 * HOUR),
				matchedAt: matched ? at(NOW, -HOUR) : undefined,
			});
		}
		await runCalibrationSweep(db, NOW);
		for (const [, score, , outcome] of cases) {
			const [row] = await recordsByScore(score);
			expect(row?.outcome, String(score)).toBe(outcome);
		}
	});

	it("予測はペアごとの評価の行からJevの7軸を写す(グループは全ペア)", async () => {
		await seedLatch({
			status: "rejected",
			score: 0.6301,
			proposedAt: at(NOW, -HOUR),
			size: 3,
			withJev: true,
		});
		await runCalibrationSweep(db, NOW);
		const [row] = await recordsByScore(0.6301);
		const prediction = row?.prediction as {
			latch_score: number;
			jev: Record<string, number>[];
		};
		expect(prediction.latch_score).toBe(0.6301);
		expect(prediction.jev).toHaveLength(3);
		expect(Object.keys(prediction.jev[0]).sort()).toEqual(
			Object.keys(AXES).sort(),
		);
	});
});

describe("毎分Cronでの点検の頻度", () => {
	it("観測中の行の点検を省いた実行でも、成立しなかった提案は作った直後に確定し、観測を終えた紐づいた行は次の点検まで残る", async () => {
		const T0 = new Date("2026-03-20T03:00:00Z");
		await seedLatch({
			status: "matched",
			score: 0.6311,
			proposedAt: at(T0, -HOUR),
			matchedAt: T0,
		});
		await runCalibrationSweep(db, at(T0, DAY));
		await seedLatch({
			status: "expired",
			score: 0.6312,
			proposedAt: at(T0, 31 * DAY),
		});
		const later = at(T0, 31 * DAY + 5 * MIN);
		await runCalibrationSweep(db, later, { checkLinked: false });
		expect((await recordsByScore(0.6311))[0]?.anonymized).toBe(false);
		expect((await recordsByScore(0.6312))[0]?.anonymized).toBe(true);
		await runCalibrationSweep(db, later);
		expect((await recordsByScore(0.6311))[0]?.anonymized).toBe(true);
	});
});

describe("形式ごとのActual Action", () => {
	it("つながり: 成立から7日・30日の往復とチャット開始・ブロック・通報・1問を、成立から30日で確定する", async () => {
		const T0 = new Date("2026-04-01T03:00:00Z");
		const seeded = await seedLatch({
			status: "matched",
			score: 0.6401,
			proposedAt: at(T0, -2 * HOUR),
			matchedAt: T0,
			withJev: true,
		});
		const [a, b] = seeded.userIds;
		const say = (userId: string, ms: number) =>
			db.insert(messages).values({
				id: ulid(at(T0, ms).getTime()),
				latchId: seeded.id,
				userId,
				body: "本文",
				clientId: null,
				createdAt: at(T0, ms),
			});
		await say(a, HOUR);
		await say(b, 2 * HOUR);
		await say(a, 3 * HOUR);
		await say(a, 4 * HOUR);
		await say(b, 10 * DAY);
		await say(a, 40 * DAY); // 30日の外
		await db.insert(blocks).values({
			blockerUserId: b,
			blockedUserId: a,
			createdAt: at(T0, 12 * DAY),
		});
		await db.insert(reports).values({
			id: ulid(),
			reporter: b,
			reportee: a,
			reason: "spam",
			target: "message",
			latchId: seeded.id,
			messageId: null,
			note: "",
			status: "open",
			createdAt: at(T0, 12 * DAY),
		});
		await db.insert(latchFeedback).values([
			{
				id: ulid(),
				latchId: seeded.id,
				userId: a,
				kind: "connection_quality",
				value: { score: 4 },
				createdAt: at(T0, 8 * DAY),
			},
			{
				id: ulid(),
				latchId: seeded.id,
				userId: b,
				kind: "connection_quality",
				value: { score: null },
				createdAt: at(T0, 8 * DAY),
			},
		]);

		// 観測の間はLATCHに紐づけたまま
		await runCalibrationSweep(db, at(T0, 29 * DAY));
		const [linked] = await recordsByScore(0.6401);
		expect(linked?.latchId).toBe(seeded.id);
		expect(linked?.anonymized).toBe(false);

		await runCalibrationSweep(db, at(T0, 31 * DAY));
		const [row] = await recordsByScore(0.6401);
		expect(row?.anonymized).toBe(true);
		expect(row?.latchId).toBeNull();
		expect(row?.action).toEqual({
			chat_started_7d: true,
			exchanges_7d: 2,
			exchanges_30d: 3,
			blocked: true,
			reported: true,
		});
		expect(row?.survey).toEqual({ scores: [4], skipped: 1 });
	});

	it("つながり: 成立しなかった提案は閉じた時点で確定し、チャットの値は0になる", async () => {
		const NOW = new Date("2026-04-05T03:00:00Z");
		await seedLatch({
			status: "expired",
			score: 0.6402,
			proposedAt: at(NOW, -DAY),
		});
		await runCalibrationSweep(db, NOW);
		const [row] = await recordsByScore(0.6402);
		expect(row?.anonymized).toBe(true);
		expect(row?.action).toEqual({
			chat_started_7d: false,
			exchanges_7d: 0,
			exchanges_30d: 0,
			blocked: false,
			reported: false,
		});
		expect(row?.survey).toBeNull();
	});

	it("機会: 参加の申告からattendedを出し、対象時刻から30日で確定する。条件は時間帯のビンと市区町村だけを持つ", async () => {
		const lat = 35.658;
		const lng = 139.7016;
		await db.insert(geofeatures).values({
			id: ulid(),
			name: "試験駅",
			municipality: "試験区",
			type: "station",
			lat: 35.655,
			lng: 139.705,
			gridKey: gridKeyOf(35.655, 139.705),
		});
		// 10:00Z = 19:00 JST
		const S = new Date("2026-05-02T10:00:00Z");
		const seeded = await seedLatch({
			form: "occasion",
			status: "completed",
			score: 0.6501,
			proposedAt: at(S, -3 * DAY),
			matchedAt: at(S, -2 * DAY),
			startsAt: S,
			geo: { lat, lng },
		});
		const [a, b] = seeded.userIds;
		await db.insert(latchFeedback).values([
			{
				id: ulid(),
				latchId: seeded.id,
				userId: a,
				kind: "attendance",
				value: { attended: true },
				createdAt: at(S, 4 * HOUR),
			},
			{
				id: ulid(),
				latchId: seeded.id,
				userId: b,
				kind: "attendance",
				value: { attended: false },
				createdAt: at(S, 4 * HOUR),
			},
		]);
		await runCalibrationSweep(db, at(S, 29 * DAY));
		expect((await recordsByScore(0.6501))[0]?.anonymized).toBe(false);
		await runCalibrationSweep(db, at(S, 31 * DAY));
		const [row] = await recordsByScore(0.6501);
		expect(row?.anonymized).toBe(true);
		expect(row?.action).toEqual({
			attended: true,
			attended_true: 1,
			attended_false: 1,
		});
		expect(row?.survey).toBeNull();
		expect(row?.context).toEqual({
			participants: 2,
			time_bin: "evening",
			municipality: "試験区",
		});
	});
});

describe("匿名化の粒度(docs/08 §7)", () => {
	it("時刻は提示した日(JST)に丸め、その日の提示が少なければ月に丸める。行にIDも地名も主題も残さない", async () => {
		// 2031-03-14 は試験の他の行と重ならない日
		const busyDay = new Date("2031-03-14T05:00:00Z");
		const quietDay = new Date("2031-04-20T05:00:00Z");
		for (let i = 0; i < MIN_DAILY_POPULATION; i += 1) {
			await seedLatch({
				status: "proposed",
				score: 0.6601 + i / 100000,
				proposedAt: at(busyDay, i * MIN),
			});
		}
		const busy = await seedLatch({
			status: "rejected",
			score: 0.6701,
			proposedAt: at(busyDay, HOUR),
			withJev: true,
		});
		const quiet = await seedLatch({
			status: "rejected",
			score: 0.6702,
			proposedAt: quietDay,
		});
		await runCalibrationSweep(db, new Date("2031-05-01T00:00:00Z"));

		const [busyRow] = await recordsByScore(0.6701);
		expect(busyRow?.createdAt).toEqual(jstDayStart(busyDay));
		expect(busyRow?.updatedAt).toEqual(jstDayStart(busyDay));
		const [quietRow] = await recordsByScore(0.6702);
		expect(quietRow?.createdAt).toEqual(jstMonthStart(quietDay));
		expect(quietRow?.updatedAt).toEqual(jstMonthStart(quietDay));
		expect(await anonymizedTimeOf(db, quietDay)).toEqual(
			jstMonthStart(quietDay),
		);

		for (const [row, seeded] of [
			[busyRow, busy],
			[quietRow, quiet],
		] as const) {
			expect(row?.latchId).toBeNull();
			expect(row?.anonymized).toBe(true);
			const text = JSON.stringify(row);
			for (const id of [seeded.id, ...seeded.userIds, ...seeded.intentIds]) {
				expect(text).not.toContain(id);
			}
			expect(text).not.toContain("秘密の主題");
		}
	});
});

describe("参加者の退会・参加Intentの削除があれば観測の途中でも匿名化する(Cronの安全網)", () => {
	it("参加Intentが消えた・参加者がdeletedのLATCHの紐づいた行は、成立から30日を待たずに確定する", async () => {
		const T0 = new Date("2026-06-01T03:00:00Z");
		const missing = await seedLatch({
			status: "matched",
			score: 0.6801,
			proposedAt: at(T0, -HOUR),
			matchedAt: T0,
		});
		const withdrawn = await seedLatch({
			status: "matched",
			score: 0.6802,
			proposedAt: at(T0, -HOUR),
			matchedAt: T0,
		});
		const kept = await seedLatch({
			status: "matched",
			score: 0.6803,
			proposedAt: at(T0, -HOUR),
			matchedAt: T0,
		});
		await runCalibrationSweep(db, at(T0, DAY));
		expect((await recordsByScore(0.6801))[0]?.anonymized).toBe(false);

		await db.delete(intents).where(eq(intents.id, missing.intentIds[0]));
		await db
			.update(users)
			.set({ status: "deleted" })
			.where(eq(users.id, withdrawn.userIds[1]));
		await runCalibrationSweep(db, at(T0, 2 * DAY));
		expect((await recordsByScore(0.6801))[0]?.anonymized).toBe(true);
		expect((await recordsByScore(0.6802))[0]?.anonymized).toBe(true);
		expect((await recordsByScore(0.6803))[0]?.latchId).toBe(kept.id);
	});
});

// --- 退会・Intent削除はAPIを通す(実フローの登録・docs/05 §2.5) ---

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
		.setExpirationTime(now + 3600)
		.sign((await importJWK(privateJwk, "RS256")) as CryptoKey);
};

interface Account {
	token: string;
	id: string;
	subject: string;
}

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
			bio: "",
			birth_date: "1990-01-01",
		}),
	});
	expect(regRes.status).toBe(201);
	const body = (await regRes.json()) as {
		user: { id: string };
		access_token: string;
	};
	return { token: body.access_token, id: body.user.id, subject };
};

const call = (
	method: "DELETE",
	path: string,
	token: string,
	body?: unknown,
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			Authorization: `Bearer ${token}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

describe("退会とIntent削除の匿名集約(docs/05 §2.5)", () => {
	it("退会すると、観測中の行と行の無い閉じた提案を、その時点までの観測で確定して匿名化する。回答と申告は残す", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const now = new Date();
		const matched = await seedLatch({
			status: "matched",
			score: 0.6901,
			proposedAt: at(now, -2 * HOUR),
			matchedAt: at(now, -HOUR),
			userIds: [a.id, b.id],
			withJev: true,
		});
		await runCalibrationSweep(db, now);
		expect((await recordsByScore(0.6901))[0]?.latchId).toBe(matched.id);
		// Cronがまだ拾っていない閉じた提案
		const rejected = await seedLatch({
			status: "rejected",
			score: 0.6902,
			proposedAt: at(now, -3 * HOUR),
			userIds: [a.id, b.id],
			withJev: true,
		});
		await db.insert(latchResponses).values({
			id: ulid(),
			latchId: rejected.id,
			userId: a.id,
			response: "yes",
			deferReason: null,
			respondedAt: at(now, -2 * HOUR),
			retractedAt: null,
		});
		await db.insert(latchFeedback).values({
			id: ulid(),
			latchId: matched.id,
			userId: b.id,
			kind: "connection_quality",
			value: { score: 5 },
			createdAt: now,
		});

		const res = await call("DELETE", "/v1/users/me", a.token, {
			provider: "google",
			idp_token: await signIdpToken(a.subject),
		});
		expect(res.status).toBe(204);

		const [m] = await recordsByScore(0.6901);
		expect(m?.anonymized).toBe(true);
		expect(m?.latchId).toBeNull();
		expect(m?.outcome).toBe("both_yes");
		expect(m?.survey).toEqual({ scores: [5], skipped: 0 });
		const [r] = await recordsByScore(0.6902);
		expect(r?.anonymized).toBe(true);
		expect(r?.outcome).toBe("one_no");
		// 候補の行を消す前に写したJevの7軸が残る
		expect((r?.prediction as { jev: unknown[] } | undefined)?.jev).toHaveLength(
			1,
		);
		// latch_responses・latch_feedbackは削除表どおり残す
		expect(
			await db
				.select()
				.from(latchResponses)
				.where(eq(latchResponses.latchId, rejected.id)),
		).toHaveLength(1);
		expect(
			await db
				.select()
				.from(latchFeedback)
				.where(eq(latchFeedback.latchId, matched.id)),
		).toHaveLength(1);
		// 再実行(Cron)でも二重に作らない
		await runCalibrationSweep(db, at(now, MIN));
		expect(await recordsByScore(0.6901)).toHaveLength(1);
		expect(await recordsByScore(0.6902)).toHaveLength(1);
	});

	it("Intentを削除すると、そのIntentから生まれた提案の行だけを匿名化する", async () => {
		const a = await registerUser("甲");
		const b = await registerUser("乙");
		const now = new Date();
		const target = await seedLatch({
			status: "matched",
			score: 0.7001,
			proposedAt: at(now, -2 * HOUR),
			matchedAt: at(now, -HOUR),
			userIds: [a.id, b.id],
			withJev: true,
		});
		const other = await seedLatch({
			status: "matched",
			score: 0.7002,
			proposedAt: at(now, -2 * HOUR),
			matchedAt: at(now, -HOUR),
			userIds: [a.id, b.id],
		});
		await runCalibrationSweep(db, now);

		const res = await call(
			"DELETE",
			`/v1/intents/${target.intentIds[0]}`,
			a.token,
		);
		expect(res.status).toBe(204);

		const [t] = await recordsByScore(0.7001);
		expect(t?.anonymized).toBe(true);
		expect(t?.latchId).toBeNull();
		expect((t?.prediction as { jev: unknown[] } | undefined)?.jev).toHaveLength(
			1,
		);
		const [o] = await recordsByScore(0.7002);
		expect(o?.anonymized).toBe(false);
		expect(o?.latchId).toBe(other.id);
	});
});
