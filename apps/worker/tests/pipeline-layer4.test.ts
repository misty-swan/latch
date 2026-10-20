/**
 * Layer 4(Jev対象選択・jev_result再利用と保存)の統合試験(設計書 §2.3・docs/06 §5)。
 * match_candidates行を直接INSERTし、runLayer4を固定時計で直接呼ぶ。
 * Jevはstub(LATCH_LLM_MODE既定)で、予算(D1)・breaker(KV)は実物を使う。
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/clock/clock";
import { intents, matchCandidates, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { JEV_LOW_MARKER } from "../src/llm/stub/jev";
import { JEV_AXES, type JevFn, type JevInput } from "../src/llm/types";
import { type L4Candidate, runLayer4 } from "../src/pipeline/layer4";
import { buildNormalizedText } from "../src/pipeline/normalize";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const NOW = new Date("2026-10-20T03:00:00Z");
const clock = fixedClock(NOW);

type IntentRow = typeof intents.$inferSelect;

const insertUser = async (id: string) => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-layer4-${id}`,
		actorType: "individual",
		displayName: "L4試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: NOW,
		updatedAt: NOW,
	});
};

const intentRow = (id: string, userId: string, topic: string): IntentRow => ({
	id,
	userId,
	form: "connection",
	topic,
	category: null,
	rawText: "L4試験用の入力文",
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
	expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
	embeddingModel: null,
	embeddedAt: null,
	lastEvaluatedAt: null,
	vectorDeletedAt: null,
	delayedReevalAt: null,
	createdAt: NOW,
	updatedAt: NOW,
});

/** 2Intent+match_candidates行(intent_a=小さいid側)を直接INSERTし、origin側を指定して返す */
const seedPair = async (
	originIsSmaller: boolean,
	topics: { small: string; large: string },
	jevResult: unknown = null,
): Promise<L4Candidate> => {
	const [smallId, largeId] = [ulid(), ulid()].sort() as [string, string];
	const smallUser = ulid();
	const largeUser = ulid();
	await insertUser(smallUser);
	await insertUser(largeUser);
	const small = intentRow(smallId, smallUser, topics.small);
	const large = intentRow(largeId, largeUser, topics.large);
	await db.insert(intents).values(small);
	await db.insert(intents).values(large);
	const rowId = ulid();
	await db.insert(matchCandidates).values({
		id: rowId,
		intentAId: smallId,
		intentBId: largeId,
		intentAVersion: 1,
		intentBVersion: 1,
		form: "connection",
		retrievalScore: 0.8,
		cheapJudgeScore: 0.7,
		jevResult,
		status: "candidate",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return {
		rowId,
		origin: originIsSmaller ? small : large,
		other: originIsSmaller ? large : small,
		cheapScore: 0.7,
	};
};

const jevResultOf = async (rowId: string) =>
	(
		await db
			.select({ jevResult: matchCandidates.jevResult })
			.from(matchCandidates)
			.where(eq(matchCandidates.id, rowId))
	)[0]?.jevResult as Record<string, number> | null;

describe("runLayer4", () => {
	it("jev_result既存の行は再利用され、Jevは呼ばれない", async () => {
		const existing = Object.fromEntries(JEV_AXES.map((a) => [a, 0.77]));
		const c = await seedPair(
			true,
			{ small: "再利用A", large: "再利用B" },
			existing,
		);
		const r = await runLayer4(testEnv, clock, [c]);
		expect(r.reused).toBe(1);
		expect(r.run.calls).toBe(0);
		expect(r.axesByRow.get(c.rowId)).toEqual(existing);
	});

	it("新規行はjev_resultに7軸すべての数値が保存される", async () => {
		const c = await seedPair(true, { small: "新規A", large: "新規B" });
		const r = await runLayer4(testEnv, clock, [c]);
		expect(r.reused).toBe(0);
		expect(r.run.calls).toBe(1);
		const saved = await jevResultOf(c.rowId);
		expect(saved).not.toBeNull();
		for (const axis of JEV_AXES) {
			expect(typeof saved?.[axis]).toBe("number");
		}
		expect(saved).toHaveProperty("would_a_accept_b");
		expect(saved).toHaveProperty("would_b_accept_a");
		expect(r.axesByRow.get(c.rowId)).toEqual(saved);
	});

	it("intent_aがoriginでない行でも、normalizedAはintent_a側のテキストになる", async () => {
		// 小さいid側(=intent_a)は相手、originは大きいid側。低値マーカーはintent_a側topicのみ
		const c = await seedPair(false, {
			small: `${JEV_LOW_MARKER}相手側`,
			large: "起点側",
		});
		expect(c.origin.id > c.other.id).toBe(true);
		const r = await runLayer4(testEnv, clock, [c]);
		const axes = r.axesByRow.get(c.rowId);
		expect(axes).toBeDefined();
		// normalizedAがintent_a側(マーカー付き)ならstubは全軸0.3
		for (const axis of JEV_AXES) {
			expect(axes?.[axis]).toBe(0.3);
		}
		expect(axes?.would_a_accept_b).toBe(0.3);
		expect(axes?.would_b_accept_a).toBe(0.3);
	});

	it("JevInputのnormalizedA/Bは行の向き(intent_a=小さいid側)で渡される", async () => {
		const c = await seedPair(false, {
			small: "小さいid側",
			large: "大きいid側",
		});
		const seen: JevInput[] = [];
		const fake: JevFn = async (input) => {
			seen.push(input);
			return {
				ok: true,
				axes: Object.fromEntries(JEV_AXES.map((a) => [a, 0.9])) as Record<
					(typeof JEV_AXES)[number],
					number
				>,
			};
		};
		await runLayer4(testEnv, clock, [c], { primary: fake, fallback: fake });
		expect(seen).toHaveLength(1);
		// originは大きいid側(intent_b)。A=other(小さいid側)・B=origin
		expect(seen[0]?.normalizedA).toBe(buildNormalizedText(c.other));
		expect(seen[0]?.normalizedB).toBe(buildNormalizedText(c.origin));
	});
});
