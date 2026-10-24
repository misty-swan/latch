/**
 * flushPushの統合試験(F7b設計 §5.1・§5.2・§5.6)。
 * 行を直接INSERTで配置し、送り手は呼び出しを記録する試験実装を使う。
 */
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { type Clock, fixedClock } from "../src/clock/clock";
import {
	intents,
	latches,
	notifications,
	pushSubscriptions,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import type { IntentRow } from "../src/pipeline/consumer";
import { flushPush } from "../src/push/dispatch";
import { PUSH_BODIES } from "../src/push/payload";
import type {
	PushSender,
	PushSendResult,
	PushTarget,
} from "../src/push/sender";

const db = drizzle((env as unknown as WorkerEnv).DB);
const NOW = new Date("2026-06-01T03:00:00Z");
const CLOCK = fixedClock(NOW);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

interface Call {
	target: PushTarget;
	payload: string;
	opts: { ttl: number; urgency: "high" };
}

/** 呼び出しを記録し、endpointごとに結果を差し替えられる送り手 */
const recorder = (
	resultOf: (t: PushTarget) => PushSendResult = () => ({ kind: "ok" }),
) => {
	const calls: Call[] = [];
	const sender: PushSender = {
		async send(target, payload, opts) {
			calls.push({ target, payload, opts });
			return resultOf(target);
		},
	};
	return { sender, calls };
};

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `push-dispatch-${id}`,
		actorType: "individual",
		displayName: "送信試験",
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
	level: "proposals_only" | "muted" = "proposals_only",
): Promise<string> => {
	const row: IntentRow = {
		id: ulid(),
		userId,
		form: "connection",
		topic: "送信試験の主題",
		category: null,
		rawText: "送信試験用",
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
		notificationLevel: level,
		alcoholInvolved: false,
		status: "active",
		version: 1,
		expiresAt: later(30 * 24 * HOUR),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: ago(24 * HOUR),
		updatedAt: ago(24 * HOUR),
	};
	await db.insert(intents).values(row);
	return row.id;
};

const insertLatch = async (intentIds: string[]): Promise<string> => {
	const id = ulid();
	await db.insert(latches).values({
		id,
		form: "connection",
		intentIds,
		proposal: {},
		score: 0.9,
		status: "proposed",
		responseDeadline: later(2 * HOUR),
		expiresAt: later(7 * HOUR),
		lastMessageAt: ago(HOUR),
		completedAt: null,
		proposedAt: ago(HOUR),
		createdAt: ago(HOUR),
		updatedAt: ago(HOUR),
	});
	return id;
};

const insertSub = async (
	userId: string,
	status: "active" | "failed" = "active",
): Promise<string> => {
	const endpoint = `https://fcm.googleapis.com/fcm/send/${ulid()}`;
	await db.insert(pushSubscriptions).values({
		id: ulid(),
		userId,
		endpoint,
		p256dh: "p",
		auth: "a",
		status,
		lastSuccessAt: null,
		createdAt: ago(HOUR),
	});
	return endpoint;
};

interface NotifOpts {
	type?: "proposal" | "matched";
	createdAt?: Date;
	pushState?: "none" | "pending";
	attemptedAt?: Date | null;
}

const insertNotif = async (
	userId: string,
	latchId: string,
	o: NotifOpts = {},
): Promise<string> => {
	const id = ulid();
	await db.insert(notifications).values({
		id,
		userId,
		type: o.type ?? "proposal",
		latchId,
		readAt: null,
		createdAt: o.createdAt ?? ago(MIN),
		intentId: null,
		pushState: o.pushState ?? "pending",
		pushAttemptedAt: o.attemptedAt ?? null,
	});
	return id;
};

const notifOf = async (id: string) => {
	const [row] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id));
	return row;
};

const subOf = async (endpoint: string) => {
	const [row] = await db
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.endpoint, endpoint));
	return row;
};

/** 本人のIntent1件だけを持つ新しいLATCH(通知の一意制約を避ける試験用) */
const freshLatch = async (userId: string): Promise<string> =>
	insertLatch([await insertIntent(userId)]);

/** 2人のLATCHと双方への通知(proposal)を配置する */
const setup = async (
	levelA: "proposals_only" | "muted" = "proposals_only",
	levelB: "proposals_only" | "muted" = "proposals_only",
) => {
	const ua = await insertUser();
	const ub = await insertUser();
	const ia = await insertIntent(ua, levelA);
	const ib = await insertIntent(ub, levelB);
	const latchId = await insertLatch([ia, ib]);
	const na = await insertNotif(ua, latchId);
	const nb = await insertNotif(ub, latchId);
	return { ua, ub, latchId, na, nb };
};

describe("送出の判断(F7b設計 §5.1・§5.2・flushPush経由)", () => {
	// 件数を厳密に確かめるため、先行の試験が残したpending行を消す
	beforeEach(async () => {
		await db.delete(notifications);
	});

	it("①active購読1件へ送り、sent・last_success_at更新・汎用文のペイロード", async () => {
		const { ua, na } = await setup();
		const ep = await insertSub(ua);
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("sent");
		expect((await subOf(ep)).lastSuccessAt?.getTime()).toBe(NOW.getTime());
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].payload)).toEqual({
			type: "proposal",
			body: PUSH_BODIES.proposal,
		});
		expect(calls[0].opts.urgency).toBe("high");
		// 回答期限(2時間後)までの秒数
		expect(calls[0].opts.ttl).toBe(2 * 3600);
	});

	it("matchedはLATCHの回答期限を使わず86,400秒", async () => {
		const ua = await insertUser();
		const ia = await insertIntent(ua);
		const latchId = await insertLatch([ia]);
		await insertNotif(ua, latchId, { type: "matched" });
		await insertSub(ua);
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect(calls[0].opts.ttl).toBe(86_400);
		expect(JSON.parse(calls[0].payload).type).toBe("matched");
	});

	it("②本人の参加Intentがmutedならmutedで送らない(相手はsent)", async () => {
		const { ua, ub, na, nb } = await setup("muted", "proposals_only");
		await insertSub(ua);
		await insertSub(ub);
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("muted");
		expect((await notifOf(nb)).pushState).toBe("sent");
		expect(calls).toHaveLength(1);
	});

	it("③購読なしはno_subscription", async () => {
		const { na } = await setup();
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("no_subscription");
		expect(calls).toHaveLength(0);
	});

	it("④status=failedの購読だけならno_subscription", async () => {
		const { ua, na } = await setup();
		await insertSub(ua, "failed");
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("no_subscription");
		expect(calls).toHaveLength(0);
	});

	it("⑤retryだけならpendingのまま・push_attempted_at=now", async () => {
		const { ua, na } = await setup();
		await insertSub(ua);
		const { sender } = recorder(() => ({ kind: "retry", status: 503 }));
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		const row = await notifOf(na);
		expect(row.pushState).toBe("pending");
		expect(row.pushAttemptedAt?.getTime()).toBe(NOW.getTime());
	});

	it("⑥1件gone・1件okならsent・goneの購読はfailed", async () => {
		const { ua, na } = await setup();
		const gone = await insertSub(ua);
		const ok = await insertSub(ua);
		const { sender } = recorder((t) =>
			t.endpoint === gone ? { kind: "gone" } : { kind: "ok" },
		);
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("sent");
		expect((await subOf(gone)).status).toBe("failed");
		expect((await subOf(ok)).status).toBe("active");
	});

	it("⑦全件rejectedならfailed(購読は変えない)", async () => {
		const { ua, na } = await setup();
		const ep = await insertSub(ua);
		const { sender } = recorder(() => ({ kind: "rejected", status: 400 }));
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("failed");
		expect((await subOf(ep)).status).toBe("active");
	});

	it("⑦'全件goneでもfailed", async () => {
		const { ua, na } = await setup();
		await insertSub(ua);
		const { sender } = recorder(() => ({ kind: "gone" }));
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(na)).pushState).toBe("failed");
	});

	it("⑧並行flushPushは送り手を1回だけ呼ぶ", async () => {
		const { ua } = await setup();
		await insertSub(ua);
		const { sender, calls } = recorder();
		await Promise.all([
			flushPush(db, sender, CLOCK, { minAgeMs: 0 }),
			flushPush(db, sender, CLOCK, { minAgeMs: 0 }),
		]);
		expect(calls).toHaveLength(1);
	});

	it("pending以外(none・sent)の行には触れない", async () => {
		const { ua } = await setup();
		await insertSub(ua);
		const n = await insertNotif(ua, await freshLatch(ua), {
			pushState: "none",
		});
		const { sender, calls } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(n)).pushState).toBe("none");
		// 送ったのはsetupのpending 1件だけ(noneの行は送らない)
		expect(calls).toHaveLength(1);
	});

	it("遅れて戻った先行の試行は、順番を取り直した後続の試行の結果を上書きしない", async () => {
		const { ua, na } = await setup();
		await insertSub(ua);
		// 先行の試行(NOW)の送信中に、61秒後の後続の試行が順番を取り直し、一時失敗で
		// pendingのまま残す。その後に先行の試行が恒久失敗で戻っても、failedへ倒さない
		const laterClock = fixedClock(later(61 * SEC));
		let nested = false;
		const sender: PushSender = {
			async send() {
				if (!nested) {
					nested = true;
					await flushPush(
						db,
						{ send: async () => ({ kind: "retry", status: 503 }) },
						laterClock,
						{ minAgeMs: 0 },
					);
				}
				return { kind: "rejected", status: 400 };
			},
		};
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		const row = await notifOf(na);
		expect(row.pushState).toBe("pending");
		expect(row.pushAttemptedAt?.getTime()).toBe(later(61 * SEC).getTime());
	});
});

describe("flushPush(F7b設計 §5.6)", () => {
	// 件数を厳密に確かめるため、先行の試験が残したpending行を消す
	beforeEach(async () => {
		await db.delete(notifications);
	});

	it("⑨対象の絞り込みと件数", async () => {
		const ua = await insertUser();
		const young = await insertNotif(ua, await freshLatch(ua), {
			type: "matched",
			createdAt: ago(20 * SEC),
		});
		const old = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(40 * SEC),
		});
		const recentTry = await insertNotif(ua, await freshLatch(ua), {
			type: "matched",
			createdAt: ago(5 * MIN),
			attemptedAt: ago(30 * SEC),
		});
		const stale = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(11 * MIN),
		});
		const none = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(5 * MIN),
			pushState: "none",
		});
		const { sender } = recorder();
		const count = await flushPush(db, sender, CLOCK, { minAgeMs: 30 * SEC });
		expect(count).toBe(1);
		expect((await notifOf(old)).pushState).toBe("no_subscription");
		expect((await notifOf(young)).pushState).toBe("pending");
		expect((await notifOf(recentTry)).pushState).toBe("pending");
		expect((await notifOf(stale)).pushState).toBe("pending");
		expect((await notifOf(none)).pushState).toBe("none");
	});

	it("createdFromより前の行は拾わない", async () => {
		const ua = await insertUser();
		const before = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(40 * SEC),
		});
		const after = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(10 * SEC),
		});
		const { sender } = recorder();
		const count = await flushPush(db, sender, CLOCK, {
			minAgeMs: 0,
			createdFrom: ago(20 * SEC),
		});
		expect(count).toBe(1);
		expect((await notifOf(before)).pushState).toBe("pending");
		expect((await notifOf(after)).pushState).toBe("no_subscription");
	});

	it("試行から60秒以上たった行は再び拾う", async () => {
		const ua = await insertUser();
		const n = await insertNotif(ua, await freshLatch(ua), {
			createdAt: ago(5 * MIN),
			attemptedAt: ago(61 * SEC),
		});
		const { sender } = recorder();
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(n)).pushState).toBe("no_subscription");
	});

	it("開始から45秒を過ぎたら残りの行を判断しない(順番取りは1文で全行が開始時刻)", async () => {
		const ua = await insertUser();
		await insertSub(ua);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			ids.push(
				await insertNotif(ua, await freshLatch(ua), {
					createdAt: ago(2 * MIN),
				}),
			);
		}
		ids.sort();
		// 送信1件ごとに30秒進む時計: 1行目=NOW・2行目=NOW+30秒で取り、3行目の前に60秒経過
		let t = NOW.getTime();
		const clock: Clock = { now: () => new Date(t) };
		const { sender, calls } = recorder(() => {
			t += 30 * SEC;
			return { kind: "ok" };
		});
		const count = await flushPush(db, sender, clock, { minAgeMs: 0 });
		// 戻り値は順番を取れた件数(判断した件数ではない)
		expect(count).toBe(3);
		expect(calls).toHaveLength(2);
		const [r1, r2, r3] = await Promise.all(ids.map(notifOf));
		expect(r1.pushState).toBe("sent");
		expect(r1.pushAttemptedAt?.getTime()).toBe(NOW.getTime());
		expect(r2.pushState).toBe("sent");
		// 順番取りは1文なので全行が開始時刻で取られる(#39)
		expect(r2.pushAttemptedAt?.getTime()).toBe(NOW.getTime());
		// 判断しなかった行は順番を取ったままpendingに残る
		expect(r3.pushState).toBe("pending");
		expect(r3.pushAttemptedAt?.getTime()).toBe(NOW.getTime());
	});

	it("時間の上限で残った行は、60秒後のflushPush(Cronと同じminAgeMs 30秒)が取り直す", async () => {
		const ua = await insertUser();
		await insertSub(ua);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			ids.push(
				await insertNotif(ua, await freshLatch(ua), {
					createdAt: ago(2 * MIN),
				}),
			);
		}
		ids.sort();
		let t = NOW.getTime();
		const clock: Clock = { now: () => new Date(t) };
		const first = recorder(() => {
			t += 30 * SEC;
			return { kind: "ok" };
		});
		expect(await flushPush(db, first.sender, clock, { minAgeMs: 0 })).toBe(3);
		expect(first.calls).toHaveLength(2);
		// 60秒たっていない間は取り直されない
		t = NOW.getTime() + 59 * SEC;
		const early = recorder();
		expect(
			await flushPush(db, early.sender, clock, { minAgeMs: 30 * SEC }),
		).toBe(0);
		t = NOW.getTime() + 61 * SEC;
		const second = recorder();
		expect(
			await flushPush(db, second.sender, clock, { minAgeMs: 30 * SEC }),
		).toBe(1);
		expect(second.calls).toHaveLength(1);
		expect((await notifOf(ids[2] as string)).pushState).toBe("sent");
	});

	it("2つのflushPushを同時に走らせても、同じ通知は1回しか送られない", async () => {
		const ua = await insertUser();
		await insertSub(ua);
		for (let i = 0; i < 5; i++) {
			await insertNotif(ua, await freshLatch(ua), { createdAt: ago(2 * MIN) });
		}
		const { sender, calls } = recorder();
		const [c1, c2] = await Promise.all([
			flushPush(db, sender, CLOCK, { minAgeMs: 0 }),
			flushPush(db, sender, CLOCK, { minAgeMs: 0 }),
		]);
		expect(c1 + c2).toBe(5);
		expect(calls).toHaveLength(5);
	});

	it("対象が複数でも結果は従来と同じ(muted・購読なし・sent・failed・retry)", async () => {
		const ud = await insertUser();
		await insertSub(ud);
		const nSent = await insertNotif(ud, await freshLatch(ud), {
			createdAt: ago(2 * MIN),
		});
		const muted = await setup("muted");
		await insertSub(muted.ua);
		const noSub = await insertUser();
		const nNoSub = await insertNotif(noSub, await freshLatch(noSub), {
			createdAt: ago(2 * MIN),
		});
		const ub = await insertUser();
		const subRejected = await insertSub(ub);
		const nRej = await insertNotif(ub, await freshLatch(ub), {
			createdAt: ago(2 * MIN),
		});
		const uc = await insertUser();
		const subRetry = await insertSub(uc);
		const nRetry = await insertNotif(uc, await freshLatch(uc), {
			createdAt: ago(2 * MIN),
		});
		const { sender } = recorder((t) =>
			t.endpoint === subRejected
				? { kind: "rejected", status: 400 }
				: t.endpoint === subRetry
					? { kind: "retry", status: 503 }
					: { kind: "ok" },
		);
		await flushPush(db, sender, CLOCK, { minAgeMs: 0 });
		expect((await notifOf(nSent)).pushState).toBe("sent");
		expect((await notifOf(muted.na)).pushState).toBe("muted");
		expect((await notifOf(nNoSub)).pushState).toBe("no_subscription");
		expect((await notifOf(nRej)).pushState).toBe("failed");
		const r = await notifOf(nRetry);
		expect(r.pushState).toBe("pending");
		expect(r.pushAttemptedAt?.getTime()).toBe(NOW.getTime());
	});
});
