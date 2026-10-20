/**
 * 提案クローズの共通処理(closeLatch)と保留の解放・期限切れ(releaseHeld・expireHeld)の
 * 統合試験(F4a設計 §3.5・§4.2)。行を直接INSERTで配置する。
 */
import { env } from "cloudflare:test";
import type { IntentStatus, LatchStatus } from "@latch/shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { closeLatch } from "../src/latches/close";
import { expireHeld, releaseHeld } from "../src/latches/release";
import type { IntentRow } from "../src/pipeline/consumer";

const db = drizzle((env as unknown as WorkerEnv).DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

type Form = "occasion" | "connection";

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `latches-release-${id}`,
		actorType: "individual",
		displayName: "保留解放試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: ago(48 * HOUR),
		updatedAt: ago(48 * HOUR),
	});
	return id;
};

const insertIntent = async (
	userId: string,
	form: Form,
	overrides: Partial<IntentRow> = {},
): Promise<IntentRow> => {
	const occasion = form === "occasion";
	const row: IntentRow = {
		id: ulid(),
		userId,
		form,
		topic: "保留解放試験の主題",
		category: null,
		rawText: "保留解放試験用",
		startsAt: occasion ? later(4 * HOUR) : null,
		endsAt: occasion ? later(6 * HOUR) : null,
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
		expiresAt: occasion ? later(7 * HOUR) : later(30 * 24 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: ago(24 * HOUR),
		updatedAt: ago(24 * HOUR),
		...overrides,
	};
	await db.insert(intents).values(row);
	return row;
};

interface LatchOpts {
	status?: LatchStatus;
	score?: number;
	proposedAt?: Date | null;
	expiresAt?: Date;
}

/** 2Intentの間のLATCH・members・proposal_history(latch_idが指す)を配置する */
const insertLatch = async (
	a: IntentRow,
	b: IntentRow,
	opts: LatchOpts = {},
): Promise<string> => {
	const form = a.form ?? "occasion";
	const status = opts.status ?? "candidate";
	const expiresAt =
		opts.expiresAt ??
		new Date(
			Math.min(a.expiresAt?.getTime() ?? 0, b.expiresAt?.getTime() ?? 0),
		);
	const timeWindow =
		form === "occasion" && a.startsAt !== null && b.startsAt !== null
			? {
					start: new Date(
						Math.max(a.startsAt.getTime(), b.startsAt.getTime()),
					).toISOString(),
					end: later(6 * HOUR).toISOString(),
				}
			: null;
	const id = ulid();
	await db.insert(latches).values({
		id,
		form,
		intentIds: [a.id, b.id],
		proposal: {
			form,
			topic: a.topic,
			time_window: timeWindow,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		},
		score: opts.score ?? 0.9,
		status,
		responseDeadline: expiresAt,
		expiresAt,
		lastMessageAt: ago(HOUR),
		completedAt: null,
		proposedAt:
			opts.proposedAt !== undefined
				? opts.proposedAt
				: status === "candidate"
					? null
					: ago(HOUR),
		createdAt: ago(HOUR),
		updatedAt: ago(HOUR),
	});
	await db.insert(latchMembers).values([
		{ latchId: id, userId: a.userId },
		{ latchId: id, userId: b.userId },
	]);
	const [low, high] =
		a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
	await db
		.insert(proposalHistory)
		.values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: id,
			outcome: "proposed",
			createdAt: ago(HOUR),
			updatedAt: ago(HOUR),
		})
		.onConflictDoUpdate({
			target: [proposalHistory.userLow, proposalHistory.userHigh],
			set: { latchId: id },
		});
	return id;
};

/** 2ユーザー・2Intent・保留LATCH1件 */
const setupPair = async (
	form: Form,
	overrides: Partial<IntentRow> = {},
	opts: LatchOpts = {},
) => {
	const ua = await insertUser();
	const ub = await insertUser();
	const a = await insertIntent(ua, form, overrides);
	const b = await insertIntent(ub, form, overrides);
	const latchId = await insertLatch(a, b, opts);
	return { a, b, latchId, userIds: [ua, ub] };
};

/** 当日(JST)のproposal通知を指定件数配置する(別LATCH宛) */
const fillProposalNotifications = async (userId: string, n: number) => {
	for (let i = 0; i < n; i++) {
		await db.insert(notifications).values({
			id: ulid(),
			userId,
			type: "proposal",
			latchId: ulid(),
			readAt: null,
			createdAt: ago(MIN),
		});
	}
};

const latchOf = async (id: string) => {
	const [row] = await db.select().from(latches).where(eq(latches.id, id));
	return row;
};

const notificationsOf = (latchId: string) =>
	db.select().from(notifications).where(eq(notifications.latchId, latchId));

const eventsOf = (latchId: string) =>
	db
		.select()
		.from(latchStatusEvents)
		.where(eq(latchStatusEvents.latchId, latchId));

const historyOf = async (latchId: string) => {
	const [row] = await db
		.select()
		.from(proposalHistory)
		.where(eq(proposalHistory.latchId, latchId));
	return row;
};

describe("releaseHeld", () => {
	it("(a) 通知上限で保留した提案は、当日分の通知が前日付になるとproposedへ昇格し期限は提示時刻基準", async () => {
		const { a, latchId, userIds } = await setupPair("occasion");
		await fillProposalNotifications(a.userId, 6);

		expect(await releaseHeld(db, NOW, userIds)).toBe(0);
		expect((await latchOf(latchId))?.status).toBe("candidate");

		// 当日分の通知を前日付へずらす(日付の変わり目で空きが出た状態)
		await db
			.update(notifications)
			.set({ createdAt: ago(24 * HOUR) })
			.where(eq(notifications.userId, a.userId));

		const presentedAt = later(10 * MIN);
		expect(await releaseHeld(db, presentedAt, userIds)).toBe(1);
		const row = await latchOf(latchId);
		expect(row?.status).toBe("proposed");
		expect(row?.proposedAt?.getTime()).toBe(presentedAt.getTime());
		expect(row?.updatedAt.getTime()).toBe(presentedAt.getTime());
		// 機会: min(max(提示+15分, min(提示+2時間, 対象時刻(NOW+4時間)-60分)), Intent期限最小) = 提示+2時間
		expect(row?.responseDeadline.getTime()).toBe(
			presentedAt.getTime() + 2 * HOUR,
		);
		const notes = await notificationsOf(latchId);
		expect(notes.map((n) => n.type)).toEqual(["proposal", "proposal"]);
		expect(new Set(notes.map((n) => n.userId))).toEqual(new Set(userIds));
		expect(
			notes.every((n) => n.createdAt.getTime() === presentedAt.getTime()),
		).toBe(true);
		const events = await eventsOf(latchId);
		expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
			["candidate", "proposed"],
		]);
	});

	it("(b) つながりの保留3件(score 0.7/0.9/0.8)で空き1件ならscoreの最も高い0.9が昇格する", async () => {
		const u = await insertUser();
		const mine = await insertIntent(u, "connection");
		// 同時進行上限3件のうち2件を既存の進行中LATCHで埋める
		for (let i = 0; i < 2; i++) {
			const other = await insertIntent(await insertUser(), "connection");
			await insertLatch(mine, other, { status: "proposed" });
		}
		const held: Record<string, string> = {};
		for (const score of [0.7, 0.9, 0.8]) {
			const other = await insertIntent(await insertUser(), "connection");
			held[String(score)] = await insertLatch(mine, other, { score });
		}

		expect(await releaseHeld(db, NOW, [u])).toBe(1);
		expect((await latchOf(held["0.9"] ?? ""))?.status).toBe("proposed");
		expect((await latchOf(held["0.8"] ?? ""))?.status).toBe("candidate");
		expect((await latchOf(held["0.7"] ?? ""))?.status).toBe("candidate");
		// つながり: min(提示+24時間, Intent期限最小)
		expect((await latchOf(held["0.9"] ?? ""))?.responseDeadline.getTime()).toBe(
			NOW.getTime() + 24 * HOUR,
		);
	});

	it("機会はつながりより先に、対象時刻の近い順に昇格する", async () => {
		const u = await insertUser();
		// 当日の通知を5件にして空きを1件にする
		await fillProposalNotifications(u, 5);
		const conn = await insertIntent(u, "connection");
		const connLatch = await insertLatch(
			conn,
			await insertIntent(await insertUser(), "connection"),
			{ score: 0.99 },
		);
		const mineFar = await insertIntent(u, "occasion", {
			startsAt: later(5 * HOUR),
		});
		const farLatch = await insertLatch(
			mineFar,
			await insertIntent(await insertUser(), "occasion", {
				startsAt: later(5 * HOUR),
			}),
		);
		const mineNear = await insertIntent(u, "occasion", {
			startsAt: later(3 * HOUR),
		});
		const nearLatch = await insertLatch(
			mineNear,
			await insertIntent(await insertUser(), "occasion", {
				startsAt: later(3 * HOUR),
			}),
		);

		expect(await releaseHeld(db, NOW, [u])).toBe(1);
		expect((await latchOf(nearLatch))?.status).toBe("proposed");
		expect((await latchOf(farLatch))?.status).toBe("candidate");
		expect((await latchOf(connLatch))?.status).toBe("candidate");
	});

	it("(c) 保留中に参加Intentの期限を過ぎたものはexpiredで閉じる(通知0・履歴expired)", async () => {
		const { latchId, userIds } = await setupPair(
			"occasion",
			{},
			{ expiresAt: ago(MIN) },
		);
		expect(await releaseHeld(db, NOW, userIds)).toBe(0);
		expect((await latchOf(latchId))?.status).toBe("expired");
		expect(await notificationsOf(latchId)).toHaveLength(0);
		expect((await historyOf(latchId))?.outcome).toBe("expired");
		const events = await eventsOf(latchId);
		expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
			["candidate", "expired"],
		]);
	});

	it("(e) closeLatchでcancelledにした保留はreleaseHeldで昇格しない", async () => {
		const { latchId } = await setupPair("connection");
		expect(
			await closeLatch(db, latchId, "cancelled", "expired", ["candidate"], NOW),
		).toBe(true);
		// userIds指定なし(全体対象)でも対象外
		await releaseHeld(db, later(MIN));
		expect((await latchOf(latchId))?.status).toBe("cancelled");
		expect(await notificationsOf(latchId)).toHaveLength(0);
	});

	it.each<IntentStatus | "missing">([
		"matched",
		"expired",
		"cancelled",
		"missing",
	])(
		"参加Intentが%sの保留はcancelledで閉じる(通知0・履歴expired)",
		async (state) => {
			const ua = await insertUser();
			const ub = await insertUser();
			const a = await insertIntent(ua, "connection");
			const b =
				state === "missing"
					? // 削除済み(行が無い)Intentを模す
						{ ...a, id: ulid(), userId: ub }
					: await insertIntent(ub, "connection", { status: state });
			const latchId = await insertLatch(a, b);

			expect(await releaseHeld(db, NOW, [ua, ub])).toBe(0);
			expect((await latchOf(latchId))?.status).toBe("cancelled");
			expect(await notificationsOf(latchId)).toHaveLength(0);
			expect((await historyOf(latchId))?.outcome).toBe("expired");
			const events = await eventsOf(latchId);
			expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
				["candidate", "cancelled"],
			]);
		},
	);

	it("参加Intentがpausedの保留は昇格も取り消しもせず保留のまま残す", async () => {
		const ua = await insertUser();
		const ub = await insertUser();
		const a = await insertIntent(ua, "connection");
		const b = await insertIntent(ub, "connection", { status: "paused" });
		const latchId = await insertLatch(a, b);

		expect(await releaseHeld(db, NOW, [ua, ub])).toBe(0);
		const row = await latchOf(latchId);
		expect(row?.status).toBe("candidate");
		expect(row?.proposedAt).toBeNull();
		expect(await notificationsOf(latchId)).toHaveLength(0);
		expect(await eventsOf(latchId)).toHaveLength(0);
	});

	it("userIds指定時は他ユーザーの保留に触れない", async () => {
		const mine = await setupPair("connection");
		const others = await setupPair("connection");
		expect(await releaseHeld(db, NOW, mine.userIds)).toBe(1);
		expect((await latchOf(mine.latchId))?.status).toBe("proposed");
		expect((await latchOf(others.latchId))?.status).toBe("candidate");
	});

	it("userIds指定時は他ユーザーの期限切れ保留を閉じない(全体の期限処理はCronが別に行う)", async () => {
		const mine = await setupPair("connection");
		const othersOverdue = await setupPair(
			"connection",
			{},
			{ expiresAt: ago(MIN) },
		);
		const othersTooLate = await setupPair("occasion", {
			startsAt: later(74 * MIN),
		});
		expect(await releaseHeld(db, NOW, mine.userIds)).toBe(1);
		expect((await latchOf(othersOverdue.latchId))?.status).toBe("candidate");
		expect((await latchOf(othersTooLate.latchId))?.status).toBe("candidate");
	});

	it("userIds指定時、対象範囲内で対象時刻まで75分未満の機会の保留は昇格させずexpiredで閉じる", async () => {
		const { latchId, userIds } = await setupPair("occasion", {
			startsAt: later(74 * MIN),
		});
		expect(await releaseHeld(db, NOW, userIds)).toBe(0);
		expect((await latchOf(latchId))?.status).toBe("expired");
		expect((await historyOf(latchId))?.outcome).toBe("expired");
		expect(await notificationsOf(latchId)).toHaveLength(0);
	});

	it("userIdsが100件を超えても照会をチャンク分割して昇格できる", async () => {
		const mine = await setupPair("connection");
		const many = [
			...Array.from({ length: 150 }, () => ulid()),
			...mine.userIds,
		];
		expect(await releaseHeld(db, NOW, many)).toBe(1);
		expect((await latchOf(mine.latchId))?.status).toBe("proposed");
	});
});

describe("expireHeld", () => {
	it("機会で対象時刻まで75分未満となった保留はexpiredで閉じ、ちょうど75分は残す", async () => {
		const tooLate = await setupPair("occasion", {
			startsAt: later(74 * MIN),
		});
		const justOk = await setupPair("occasion", {
			startsAt: later(75 * MIN),
		});
		const closed = await expireHeld(db, NOW);
		expect(closed).toBeGreaterThanOrEqual(1);
		expect((await latchOf(tooLate.latchId))?.status).toBe("expired");
		expect((await historyOf(tooLate.latchId))?.outcome).toBe("expired");
		expect(await notificationsOf(tooLate.latchId)).toHaveLength(0);
		expect((await latchOf(justOk.latchId))?.status).toBe("candidate");
	});

	it("75分より十分先の機会の保留が多数あっても0件を返し、candidateのまま残す", async () => {
		const far = [];
		for (let i = 0; i < 5; i++) far.push(await setupPair("occasion"));
		// 前日の時刻で走査する(他の試験が配置した保留もすべて期限・対象時刻の十分前になる)
		expect(await expireHeld(db, ago(24 * HOUR))).toBe(0);
		for (const { latchId } of far) {
			expect((await latchOf(latchId))?.status).toBe("candidate");
		}
	});

	it("対象時刻(proposal.time_window.start)が絞り込み条件に合わない保留は参加Intentを読まない", async () => {
		// 参加Intentのstarts_atは75分未満だが、proposalの対象時刻は十分先という不整合な行を置く。
		// 参加Intentを読んでisTooLateで判定していればexpiredになるので、残ればSQLで除外されている
		const { latchId } = await setupPair("occasion", {
			startsAt: later(74 * MIN),
		});
		const [row] = await db
			.select({ proposal: latches.proposal })
			.from(latches)
			.where(eq(latches.id, latchId));
		await db
			.update(latches)
			.set({
				proposal: {
					...(row?.proposal as object),
					time_window: {
						start: later(4 * HOUR).toISOString(),
						end: later(6 * HOUR).toISOString(),
					},
				},
			})
			.where(eq(latches.id, latchId));
		await expireHeld(db, NOW);
		expect((await latchOf(latchId))?.status).toBe("candidate");
	});

	it("expires_atちょうどの保留はexpiredで閉じ、閉じた件数を返す", async () => {
		const { latchId } = await setupPair(
			"connection",
			{},
			{ expiresAt: later(HOUR) },
		);
		const at = later(HOUR);
		const before = await db
			.select({ id: latches.id })
			.from(latches)
			.where(eq(latches.status, "candidate"));
		const closed = await expireHeld(db, at);
		expect(closed).toBeGreaterThanOrEqual(1);
		expect(closed).toBeLessThanOrEqual(before.length);
		expect((await latchOf(latchId))?.status).toBe("expired");
	});
});

describe("closeLatch", () => {
	it("(d) 提示済み提案を閉じると参加者2人にclosed通知・履歴更新・状態遷移を記録する", async () => {
		const { latchId, userIds } = await setupPair(
			"connection",
			{},
			{ status: "partial_accept" },
		);
		expect(
			await closeLatch(
				db,
				latchId,
				"rejected",
				"deferred",
				["proposed", "partial_accept"],
				NOW,
			),
		).toBe(true);
		const row = await latchOf(latchId);
		expect(row?.status).toBe("rejected");
		expect(row?.updatedAt.getTime()).toBe(NOW.getTime());
		const notes = await notificationsOf(latchId);
		expect(notes.map((n) => n.type)).toEqual(["closed", "closed"]);
		expect(new Set(notes.map((n) => n.userId))).toEqual(new Set(userIds));
		const history = await historyOf(latchId);
		expect(history?.outcome).toBe("deferred");
		expect(history?.updatedAt.getTime()).toBe(NOW.getTime());
		const events = await eventsOf(latchId);
		expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
			["partial_accept", "rejected"],
		]);
	});

	it("(d) 未提示(candidate)の提案を閉じても通知は0件", async () => {
		const { latchId } = await setupPair("connection");
		expect(
			await closeLatch(db, latchId, "cancelled", "expired", ["candidate"], NOW),
		).toBe(true);
		expect(await notificationsOf(latchId)).toHaveLength(0);
		expect((await historyOf(latchId))?.outcome).toBe("expired");
	});

	it("状態がfromStatusesに無ければfalseで何も書かない", async () => {
		const { latchId } = await setupPair(
			"connection",
			{},
			{ status: "matched" },
		);
		expect(
			await closeLatch(
				db,
				latchId,
				"expired",
				"expired",
				["proposed", "partial_accept"],
				NOW,
			),
		).toBe(false);
		expect((await latchOf(latchId))?.status).toBe("matched");
		expect(await notificationsOf(latchId)).toHaveLength(0);
		expect(await eventsOf(latchId)).toHaveLength(0);
		expect((await historyOf(latchId))?.outcome).toBe("proposed");
		expect(
			await closeLatch(db, ulid(), "expired", "expired", ["proposed"], NOW),
		).toBe(false);
	});

	it("historyOutcome=nullなら履歴を変えず、履歴が別のLATCHを指していれば触らない", async () => {
		const { a, b, latchId } = await setupPair(
			"occasion",
			{},
			{ status: "matched" },
		);
		expect(
			await closeLatch(db, latchId, "cancelled", null, ["matched"], NOW),
		).toBe(true);
		expect((await historyOf(latchId))?.outcome).toBe("proposed");

		// 同ペアの新しいLATCHへ履歴が移った後に古いLATCHを閉じても履歴は変わらない
		const old = await insertLatch(a, b, { status: "proposed" });
		const current = await insertLatch(a, b, { status: "proposed" });
		expect(
			await closeLatch(db, old, "expired", "expired", ["proposed"], NOW),
		).toBe(true);
		const [history] = await db
			.select()
			.from(proposalHistory)
			.where(
				and(
					inArray(proposalHistory.userLow, [a.userId, b.userId]),
					inArray(proposalHistory.userHigh, [a.userId, b.userId]),
				),
			);
		expect(history?.latchId).toBe(current);
		expect(history?.outcome).toBe("proposed");
		// 古いLATCHのclosed通知は作られる(提示済み)
		expect(await notificationsOf(old)).toHaveLength(2);
	});
});
