/**
 * オーナーへのメール(docs/04 §9・LAT-124)の試験。送る権利(usage_countersのalert_mail)による
 * 二重送信の防止とやり直し、Jev予算の80%到達のメール、前日分の日次サマリの中身と送る時刻、
 * 送り手の切り替え(LATCH_MAIL_MODE)を、本物のD1(miniflare)とモックの送信バインディングで確かめる。
 */
import { env } from "cloudflare:test";
import { LATCH, LIMITS } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock, jstDayKey, jstMonthKey } from "../src/clock/clock";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	matchEvents,
	reports,
	usageCounters,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import {
	ALERT_MAIL_MAX_ATTEMPTS,
	buildDailySummary,
	runDailySummary,
	sendAlertMailOnce,
} from "../src/mail/alert";
import {
	type AlertMail,
	type MailSender,
	mailSenderOf,
	realMailSender,
	stubMailSender,
} from "../src/mail/sender";
import type { IntentRow } from "../src/pipeline/consumer";
import { runScheduledPipeline } from "../src/pipeline/cron";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2031-04-{day}の{hour}時(日本時間) */
const at = (day: number, hour: number, minute = 0): Date =>
	new Date(
		Date.parse(
			`2031-04-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`,
		),
	);

/** 送ったメールを貯める送り手。failsの回数だけ先に失敗する */
const recordingSender = (fails = 0) => {
	const sent: AlertMail[] = [];
	let left = fails;
	const sender: MailSender = {
		async send(mail) {
			if (left > 0) {
				left -= 1;
				return { kind: "failed", errorCode: "E_DELIVERY_FAILED" };
			}
			sent.push(mail);
			return { kind: "ok" };
		},
	};
	return { sender, sent };
};

const alertMailCount = async (key: string, period: string) => {
	const [row] = await db
		.select({ count: usageCounters.count })
		.from(usageCounters)
		.where(
			and(
				eq(usageCounters.scope, "alert_mail"),
				eq(usageCounters.key, key),
				eq(usageCounters.period, period),
			),
		);
	return row?.count;
};

const MAIL: AlertMail = { subject: "件名", text: "本文" };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sendAlertMailOnce(送る権利)", () => {
	it("同じ種類と期間は1通だけ送り、2回目は本文も作らない", async () => {
		const { sender, sent } = recordingSender();
		const build = vi.fn(async () => MAIL);
		const first = await sendAlertMailOnce(
			testEnv.DB,
			sender,
			"daily_summary",
			"2031-01-01",
			build,
		);
		const second = await sendAlertMailOnce(
			testEnv.DB,
			sender,
			"daily_summary",
			"2031-01-01",
			build,
		);
		expect([first, second]).toEqual(["sent", "skipped"]);
		expect(sent).toEqual([MAIL]);
		expect(build).toHaveBeenCalledTimes(1);
		expect(await alertMailCount("daily_summary", "2031-01-01")).toBe(1);
	});

	it("同時に2つの実行が取りに来ても、送るのは片方だけ", async () => {
		const { sender, sent } = recordingSender();
		const results = await Promise.all(
			[1, 2].map(() =>
				sendAlertMailOnce(
					testEnv.DB,
					sender,
					"daily_summary",
					"2031-01-02",
					async () => MAIL,
				),
			),
		);
		expect(results.sort()).toEqual(["sent", "skipped"]);
		expect(sent).toHaveLength(1);
	});

	it("失敗したら権利を手放して次の実行がやり直し、成功した後は送らない", async () => {
		const { sender, sent } = recordingSender(1);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const once = () =>
			sendAlertMailOnce(
				testEnv.DB,
				sender,
				"jev_global_daily",
				"2031-01-03",
				async () => MAIL,
			);
		expect(await once()).toBe("failed");
		expect(await alertMailCount("jev_global_daily", "2031-01-03")).toBe(-1);
		expect(await once()).toBe("sent");
		expect(await alertMailCount("jev_global_daily", "2031-01-03")).toBe(2);
		expect(await once()).toBe("skipped");
		expect(sent).toHaveLength(1);
		const lines = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(lines).toContainEqual({
			level: "warn",
			event: "alert.mail.failed",
			layer: "jev_global_daily",
			error_code: "E_DELIVERY_FAILED",
			count: 1,
		});
		expect(lines).toContainEqual({
			level: "info",
			event: "alert.mail.sent",
			layer: "jev_global_daily",
			count: 2,
		});
	});

	it(`${ALERT_MAIL_MAX_ATTEMPTS}回失敗したら諦め、それ以上は試さない`, async () => {
		const { sender, sent } = recordingSender(99);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const once = () =>
			sendAlertMailOnce(
				testEnv.DB,
				sender,
				"jev_global_monthly",
				"2031-01",
				async () => MAIL,
			);
		const results = [];
		for (let i = 0; i < ALERT_MAIL_MAX_ATTEMPTS + 2; i += 1) {
			results.push(await once());
		}
		expect(results).toEqual([
			...Array(ALERT_MAIL_MAX_ATTEMPTS).fill("failed"),
			"skipped",
			"skipped",
		]);
		expect(sent).toEqual([]);
		expect(await alertMailCount("jev_global_monthly", "2031-01")).toBe(
			-ALERT_MAIL_MAX_ATTEMPTS,
		);
		const abandoned = logSpy.mock.calls
			.map(([line]) => JSON.parse(String(line)))
			.filter((l) => l.event === "alert.mail.abandoned");
		expect(abandoned).toEqual([
			{
				level: "error",
				event: "alert.mail.abandoned",
				layer: "jev_global_monthly",
				count: ALERT_MAIL_MAX_ATTEMPTS,
			},
		]);
	});

	it("本文の作成に失敗したら送らずに権利を手放す", async () => {
		const { sender, sent } = recordingSender();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const result = await sendAlertMailOnce(
			testEnv.DB,
			sender,
			"daily_summary",
			"2031-01-04",
			async () => {
				throw new Error("D1_ERROR");
			},
		);
		expect(result).toBe("failed");
		expect(sent).toEqual([]);
		expect(await alertMailCount("daily_summary", "2031-01-04")).toBe(-1);
	});
});

describe("送り手の切り替え(LATCH_MAIL_MODE)", () => {
	const binding = () => {
		const send = vi.fn(async () => ({ messageId: "m" }));
		return { binding: { send } as unknown as SendEmail, send };
	};

	it("既定(stub)は外へ送らない", () => {
		expect(mailSenderOf({ ...testEnv, LATCH_MAIL_MODE: undefined })).toBe(
			stubMailSender,
		);
	});

	it("realはALERT_MAIL_FROMからALERT_MAIL_TOへ件名と本文を送る", async () => {
		const { binding: b, send } = binding();
		const sender = mailSenderOf({
			...testEnv,
			LATCH_MAIL_MODE: "real",
			ALERT_MAIL: b,
			ALERT_MAIL_TO: "owner@example.com",
			ALERT_MAIL_FROM: "alerts@example.com",
		});
		expect(await sender.send(MAIL)).toEqual({ kind: "ok" });
		expect(send).toHaveBeenCalledWith({
			from: "alerts@example.com",
			to: "owner@example.com",
			subject: "件名",
			text: "本文",
		});
	});

	it("realで宛先か送り元が無ければ、送るたびに失敗(MAIL_NOT_CONFIGURED)を返す", async () => {
		const { binding: b, send } = binding();
		const sender = mailSenderOf({
			...testEnv,
			LATCH_MAIL_MODE: "real",
			ALERT_MAIL: b,
			ALERT_MAIL_TO: "owner@example.com",
			ALERT_MAIL_FROM: undefined,
		});
		expect(await sender.send(MAIL)).toEqual({
			kind: "failed",
			errorCode: "MAIL_NOT_CONFIGURED",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("Email Serviceの例外はcodeを失敗の理由にする", async () => {
		const error = Object.assign(new Error("not verified"), {
			code: "E_SENDER_NOT_VERIFIED",
		});
		const sender = realMailSender(
			{ send: async () => Promise.reject(error) } as unknown as SendEmail,
			"alerts@example.com",
			"owner@example.com",
		);
		expect(await sender.send(MAIL)).toEqual({
			kind: "failed",
			errorCode: "E_SENDER_NOT_VERIFIED",
		});
	});
});

describe("Jev予算の80%到達のメール(毎分Cron・docs/06 §6)", () => {
	it("全体1か月の80%で1通だけ送り、次の分のCronでは送らない", async () => {
		// 日次サマリの試験(2031-04)と別の月にする
		const now = new Date(Date.parse("2031-05-20T03:00:00+09:00"));
		const month = jstMonthKey(now);
		const count = LIMITS.JEV_GLOBAL_MONTHLY * LATCH.BUDGET_ALERT_RATIO;
		await db.insert(usageCounters).values({
			scope: "jev_global_monthly",
			key: "-",
			period: month,
			count,
		});
		const send = vi.fn(async () => ({ messageId: "m" }));
		const mailEnv: WorkerEnv = {
			...testEnv,
			LATCH_MAIL_MODE: "real",
			LATCH_ENV: "production",
			ALERT_MAIL: { send } as unknown as SendEmail,
			ALERT_MAIL_TO: "owner@example.com",
			ALERT_MAIL_FROM: "alerts@example.com",
		};
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runScheduledPipeline(mailEnv, fixedClock(now));
		await runScheduledPipeline(
			mailEnv,
			fixedClock(new Date(now.getTime() + 60_000)),
		);

		// 日本時間3時なので日次サマリはまだ送らない
		expect(send).toHaveBeenCalledTimes(1);
		const [mail] = send.mock.calls[0] as unknown as [
			{ subject: string; text: string },
		];
		expect(mail.subject).toBe(
			`[LATCH production] Jevの予算の80%に達しました(1か月・${month})`,
		);
		expect(mail.text).toContain("480,000回 / 上限600,000回(80.0%)");
		expect(await alertMailCount("jev_global_monthly", month)).toBe(1);
	});
});

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `alert-mail-${id}`,
		actorType: "individual",
		displayName: "メール試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: at(1, 0),
		updatedAt: at(1, 0),
	});
	return id;
};

const insertIntent = async (
	userId: string,
	form: "connection" | "occasion",
	createdAt: Date,
	status: IntentRow["status"] = "active",
): Promise<string> => {
	const occasion = form === "occasion";
	const row: IntentRow = {
		id: ulid(),
		userId,
		form,
		topic: "メール試験の主題",
		category: null,
		rawText: "メール試験用",
		startsAt: occasion ? at(25, 12) : null,
		endsAt: occasion ? at(25, 14) : null,
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
		status,
		version: 1,
		expiresAt: at(30, 0),
		embeddingModel: null,
		embeddedAt: null,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		jevHeldAt: null,
		jevHeldReason: null,
		jevHeldCount: 0,
		createdAt,
		updatedAt: createdAt,
	};
	await db.insert(intents).values(row);
	return row.id;
};

const insertLatch = async (seed: {
	form: "connection" | "occasion";
	intentIds: string[];
	members: string[];
	status: typeof latches.$inferInsert.status;
	proposedAt: Date;
	matched?: boolean;
}): Promise<void> => {
	const id = ulid();
	await db.insert(latches).values({
		id,
		form: seed.form,
		intentIds: seed.intentIds,
		proposal: {
			form: seed.form,
			topic: "メール試験の主題",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		},
		score: 0.8,
		status: seed.status,
		responseDeadline: new Date(seed.proposedAt.getTime() + DAY),
		expiresAt: at(30, 0),
		lastMessageAt: seed.proposedAt,
		completedAt: null,
		proposedAt: seed.proposedAt,
		createdAt: seed.proposedAt,
		updatedAt: seed.proposedAt,
	});
	await db
		.insert(latchMembers)
		.values(seed.members.map((userId) => ({ latchId: id, userId })));
	if (seed.matched) {
		await db.insert(latchStatusEvents).values({
			id: ulid(),
			latchId: id,
			fromStatus: "proposed",
			toStatus: "matched",
			createdAt: new Date(seed.proposedAt.getTime() + HOUR),
		});
	}
};

describe("日次サマリ(日本時間9時以降・前日分)", () => {
	it("毎分Cronから、日本時間9時の実行で前日分の日次サマリを送る", async () => {
		const send = vi.fn(async () => ({ messageId: "m" }));
		const mailEnv: WorkerEnv = {
			...testEnv,
			LATCH_MAIL_MODE: "real",
			LATCH_ENV: "production",
			ALERT_MAIL: { send } as unknown as SendEmail,
			ALERT_MAIL_TO: "owner@example.com",
			ALERT_MAIL_FROM: "alerts@example.com",
		};
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runScheduledPipeline(
			mailEnv,
			fixedClock(new Date(Date.parse("2031-06-02T09:00:00+09:00"))),
		);

		expect(
			send.mock.calls.map(
				(call) => (call as unknown as [{ subject: string }])[0].subject,
			),
		).toEqual(["[LATCH production] 日次サマリ(2031-06-01)"]);
	});

	it("前日のコスト・異常の兆し・主な指標を件数だけで載せる", async () => {
		// 前日=2031-04-10(日本時間)。期間外(9日・11日)の行を混ぜて絞り込みも確かめる
		const [a, b] = await Promise.all([insertUser(), insertUser()]);
		const c1 = await insertIntent(a, "connection", at(10, 8));
		const c2 = await insertIntent(b, "connection", at(10, 23, 59));
		const o1 = await insertIntent(a, "occasion", at(10, 12));
		await insertIntent(b, "connection", at(10, 13), "draft");
		await insertIntent(b, "connection", at(9, 23, 59));
		await insertIntent(b, "occasion", at(11, 0));
		await insertLatch({
			form: "connection",
			intentIds: [c1, c2],
			members: [a, b],
			status: "matched",
			proposedAt: at(10, 9),
			matched: true,
		});
		await insertLatch({
			form: "connection",
			intentIds: [c1, c2],
			members: [a, b],
			status: "proposed",
			proposedAt: at(10, 20),
		});
		await insertLatch({
			form: "occasion",
			intentIds: [o1, c2],
			members: [a, b],
			status: "expired",
			proposedAt: at(10, 10),
		});
		await insertLatch({
			form: "occasion",
			intentIds: [o1, c2],
			members: [a, b],
			status: "matched",
			proposedAt: at(9, 10),
			matched: true,
		});
		await db.insert(usageCounters).values([
			{
				scope: "jev_global_daily",
				key: "-",
				period: "2031-04-10",
				count: 1234,
			},
			{ scope: "jev_global_daily", key: "-", period: "2031-04-09", count: 999 },
			{
				scope: "jev_global_monthly",
				key: "-",
				period: "2031-04",
				count: 12345,
			},
			{
				scope: "external_send",
				key: "anthropic:parser",
				period: "2031-04-10",
				count: 12,
			},
			{
				scope: "external_send",
				key: "typesafe:jev",
				period: "2031-04-10",
				count: 1200,
			},
			{
				scope: "external_send",
				key: "typesafe:jev",
				period: "2031-04-09",
				count: 7,
			},
		]);
		const now = at(11, 9);
		await db.insert(matchEvents).values([
			{
				id: ulid(),
				eventType: "intent_created",
				sourceIntentId: c1,
				version: 1,
				payload: {},
				status: "dead",
				createdAt: at(10, 1),
				processedAt: null,
			},
			// 15分より前から処理待ち(数える)と、14分前の処理待ち(数えない)
			{
				id: ulid(),
				eventType: "intent_created",
				sourceIntentId: c2,
				version: 1,
				payload: {},
				status: "pending",
				createdAt: new Date(now.getTime() - 16 * 60_000),
				processedAt: null,
			},
			{
				id: ulid(),
				eventType: "intent_created",
				sourceIntentId: o1,
				version: 1,
				payload: {},
				status: "failed",
				createdAt: new Date(now.getTime() - 14 * 60_000),
				processedAt: null,
			},
		]);
		await db.insert(reports).values([
			{
				id: ulid(),
				reporter: a,
				reportee: b,
				reason: "spam",
				target: "profile",
				latchId: null,
				messageId: null,
				note: "",
				status: "open",
				createdAt: at(10, 15),
			},
			{
				id: ulid(),
				reporter: b,
				reportee: a,
				reason: "spam",
				target: "profile",
				latchId: null,
				messageId: null,
				note: "",
				status: "open",
				createdAt: at(8, 15),
			},
		]);

		const mail = await buildDailySummary(
			{ ...testEnv, LATCH_ENV: "production" },
			"2031-04-10",
			now.getTime(),
		);

		expect(mail.subject).toBe("[LATCH production] 日次サマリ(2031-04-10)");
		expect(mail.text).toContain(
			"- Jev(前日): 1,234回(1日の上限30,000回の4.1%)",
		);
		expect(mail.text).toContain(
			"- Jev(2031-04の累計): 12,345回(1か月の上限600,000回の2.1%)",
		);
		expect(mail.text).toContain(
			"  - anthropic:parser: 12回\n  - typesafe:jev: 1,200回",
		);
		expect(mail.text).toContain("- 処理を諦めたイベント(dead): 1件(0が正常)");
		expect(mail.text).toContain(
			"- 15分より前から処理待ちのイベント: 1件(0が正常)",
		);
		expect(mail.text).toContain(
			"- 未対応(open)の通報: 2件 / 前日の新しい通報: 1件",
		);
		expect(mail.text).toContain(
			"- 新しいIntent(下書きを除く): つながりIntent 2件・機会Intent 1件(合計3件)",
		);
		expect(mail.text).toContain(
			"- 提示した提案: つながりIntent 2件・機会Intent 1件(合計3件)",
		);
		expect(mail.text).toContain(
			"- 成立した提案: つながりIntent 1件・機会Intent 0件(合計1件)",
		);
		expect(mail.text).toContain(
			"- Mutual Latch Rate: つながりIntent 50.0%・機会Intent 0.0%・合計 33.3%",
		);
		expect(mail.text).toContain("回答期間中の提案が1件あり");
		// 識別子(ULID)は載せない(docs/08 §6)
		for (const id of [a, b, c1, c2, o1]) {
			expect(mail.text).not.toContain(id);
		}
	});

	it("日本時間9時より前は送らず、9時以降の最初の実行で前日分を1通だけ送る", async () => {
		const { sender, sent } = recordingSender();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const summaryEnv = { ...testEnv, LATCH_ENV: "staging" };
		await runDailySummary(summaryEnv, sender, fixedClock(at(21, 8, 59)));
		expect(sent).toEqual([]);
		await runDailySummary(summaryEnv, sender, fixedClock(at(21, 9)));
		await runDailySummary(summaryEnv, sender, fixedClock(at(21, 9, 1)));
		await runDailySummary(summaryEnv, sender, fixedClock(at(21, 23, 59)));
		expect(sent.map((m) => m.subject)).toEqual([
			"[LATCH staging] 日次サマリ(2031-04-20)",
		]);
		// 翌日は翌日の分を送る
		await runDailySummary(summaryEnv, sender, fixedClock(at(22, 9, 30)));
		expect(sent.map((m) => m.subject)).toEqual([
			"[LATCH staging] 日次サマリ(2031-04-20)",
			"[LATCH staging] 日次サマリ(2031-04-21)",
		]);
		expect(jstDayKey(at(22, 9, 30))).toBe("2031-04-22");
	});
});
