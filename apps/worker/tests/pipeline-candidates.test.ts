/**
 * 候補行のupsert(candidates.ts)の試験。
 * 評価の途中で相手の意思が削除された競り合い(#43)で、外部キー違反のバッチ全体を
 * 失敗させず、消えた意思を含む行だけを除いて1回やり直すことを確かめる。
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { intents, matchCandidates, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { upsertCandidateRows } from "../src/pipeline/candidates";
import { intentPairKey } from "../src/pipeline/group";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const now = new Date("2026-10-25T12:00:00.000Z");

/** 利用者と意思を1件ずつ投入し、意思のidを返す */
const seedIntent = async (): Promise<string> => {
	const userId = ulid();
	const intentId = ulid();
	await db.insert(users).values({
		id: userId,
		authProvider: "google",
		authSubject: `candidates-${intentId}`,
		actorType: "individual",
		displayName: "候補の試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(intents).values({
		id: intentId,
		userId,
		form: "connection",
		topic: "候補の試験の学習仲間",
		category: "学び・語学",
		rawText: "候補の試験。",
		participantsMin: 2,
		participantsMax: 3,
		participantsIncludesOwner: true,
		hardConstraints: [],
		softConstraints: [],
		negativeConstraints: [],
		visibility: "hidden_until_match",
		notificationLevel: "proposals_only",
		alcoholInvolved: false,
		status: "active",
		version: 1,
		createdAt: now,
		updatedAt: now,
	});
	return intentId;
};

/** a<bに正規化した候補行 */
const rowOf = (x: string, y: string) => {
	const [a, b] = x < y ? [x, y] : [y, x];
	return {
		id: ulid(),
		intentAId: a,
		intentBId: b,
		intentAVersion: 1,
		intentBVersion: 1,
		form: "connection",
		retrievalScore: 0.8,
		cheapJudgeScore: 0.7,
		status: "candidate",
		createdAt: now,
		updatedAt: now,
	} satisfies typeof matchCandidates.$inferInsert;
};

describe("upsertCandidateRows: 削除との競り合い(#43)", () => {
	it("存在しない意思を含む行は除き、残りの行を保存して例外を出さない", async () => {
		const origin = await seedIntent();
		const p1 = await seedIntent();
		const p2 = await seedIntent();
		const ghost = ulid();
		const rows = [rowOf(origin, p1), rowOf(origin, ghost), rowOf(origin, p2)];

		const saved = await upsertCandidateRows(db, rows, now);

		expect(saved.size).toBe(2);
		expect(saved.has(intentPairKey(origin, p1))).toBe(true);
		expect(saved.has(intentPairKey(origin, p2))).toBe(true);
		expect(saved.has(intentPairKey(origin, ghost))).toBe(false);
		const storedB = await db
			.select()
			.from(matchCandidates)
			.where(eq(matchCandidates.intentBId, ghost));
		expect(storedB).toHaveLength(0);
	});

	it("全部の行が消えた相手のときは空のMapを返す", async () => {
		const origin = await seedIntent();
		const saved = await upsertCandidateRows(
			db,
			[rowOf(origin, ulid()), rowOf(origin, ulid())],
			now,
		);
		expect(saved.size).toBe(0);
	});

	it("外部キー違反以外の失敗はやり直さず外へ出す", async () => {
		const origin = await seedIntent();
		const p1 = await seedIntent();
		// NOT NULL列にnullを入れ、外部キーではない失敗にする
		const bad = { ...rowOf(origin, p1), form: null } as unknown as ReturnType<
			typeof rowOf
		>;
		await expect(upsertCandidateRows(db, [bad], now)).rejects.toThrow();
	});
});
