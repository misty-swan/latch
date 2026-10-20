/**
 * グループ評価の準備(prepareGroups・F4b設計 §2.2〜§2.4)の統合試験。
 * 行を直接INSERTし、インメモリのベクトルストアへ直接upsertして呼ぶ。
 * - Pool内の他人どうしのペアのHard判定(blocks・提案履歴の恒久排除・Review Focus 3)
 * - 集合に現れるペアだけのmatch_candidates行のupsertと、既存jev_resultの返却
 */
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import {
	blocks,
	intents,
	matchCandidates,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { stubEmbedding } from "../src/llm/stub/embedding";
import type { IntentRow } from "../src/pipeline/consumer";
import { intentPairKey, type PoolEntry } from "../src/pipeline/group";
import { prepareGroups } from "../src/pipeline/group-eval";
import { buildNormalizedText } from "../src/pipeline/normalize";
import {
	memoryVectorStore,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);
const NOW = new Date("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
	resetMemoryVectorStore();
});

const insertUser = async (): Promise<string> => {
	const id = ulid();
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-group-${id}`,
		actorType: "individual",
		displayName: "グループ準備試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
};

/** つながりIntent(既定{3,4})を作り、ベクトルもupsertする */
const insertIntent = async (
	overrides: Partial<IntentRow> = {},
): Promise<IntentRow> => {
	const userId = await insertUser();
	const row: IntentRow = {
		id: ulid(),
		userId,
		form: "connection",
		topic: "グループ準備試験の学習仲間",
		category: null,
		rawText: "グループ準備試験用",
		startsAt: null,
		endsAt: null,
		geoCenterLat: null,
		geoCenterLng: null,
		geoRadiusM: null,
		participantsMin: 3,
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
		expiresAt: new Date(NOW.getTime() + 30 * DAY),
		embeddingModel: null,
		embeddedAt: NOW,
		lastEvaluatedAt: null,
		vectorDeletedAt: null,
		delayedReevalAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
	await db.insert(intents).values(row);
	await memoryVectorStore().upsert([
		{
			id: row.id,
			values: await stubEmbedding(buildNormalizedText(row)),
			metadata: {
				form: row.form as string,
				status: "active",
				category: null,
				user_id: row.userId,
			},
		},
	]);
	return row;
};

const entryOf = (intent: IntentRow): PoolEntry => ({
	intent,
	cheapScore: 0.8,
	similarity: 0.9,
});

/** 起点+候補3人(既定はいずれも{3,4}) */
const setupFour = async (overrides: Partial<IntentRow> = {}) => {
	const origin = await insertIntent(overrides);
	const others = [
		await insertIntent(overrides),
		await insertIntent(overrides),
		await insertIntent(overrides),
	];
	return { origin, others };
};

/** 2つのIntentの間のmatch_candidates行(版は1) */
const rowsBetween = (a: IntentRow, b: IntentRow) => {
	const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
	return db
		.select()
		.from(matchCandidates)
		.where(
			and(
				eq(matchCandidates.intentAId, lo.id),
				eq(matchCandidates.intentBId, hi.id),
			),
		);
};

/** メンバー全員のIntentに触れるmatch_candidates行の件数 */
const rowsAmong = async (members: IntentRow[]): Promise<number> => {
	let count = 0;
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			count += (await rowsBetween(members[i], members[j])).length;
		}
	}
	return count;
};

const contains = (key: string, ...ids: string[]): boolean =>
	ids.every((id) => key.split(",").includes(id));

describe("prepareGroups(F4b設計 §2.2〜§2.4)", () => {
	it("4人が互いに合格なら3人集合3件+4人集合1件・6ペア分の行をupsertする", async () => {
		const { origin, others } = await setupFour();
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			others.map(entryOf),
			NOW,
		);
		expect(prep).not.toBeNull();
		if (prep === null) return;
		expect(prep.poolSize).toBe(3);
		expect(prep.sets.filter((s) => s.members.length === 3)).toHaveLength(3);
		expect(prep.sets.filter((s) => s.members.length === 4)).toHaveLength(1);
		expect(prep.rows.size).toBe(6);
		expect(await rowsAmong([origin, ...others])).toBe(6);
		// 行の向きはa<bに正規化され、a・bのIntent行を伴う
		for (const [key, row] of prep.rows) {
			expect(row.a.id < row.b.id).toBe(true);
			expect(key).toBe(intentPairKey(row.a.id, row.b.id));
			expect(row.jevResult).toBeNull();
		}
		// 起点ペアのretrieval_score・cheap_judge_scoreはentriesの値
		const [originRow] = await rowsBetween(origin, others[0]);
		expect(originRow.retrievalScore).toBeCloseTo(0.9);
		expect(originRow.cheapJudgeScore).toBeCloseTo(0.8);
		expect(originRow.status).toBe("candidate");
		// 他人どうしはコサイン類似度(同じ正規化テキスト由来のため≈1)
		const [otherRow] = await rowsBetween(others[0], others[1]);
		expect(otherRow.retrievalScore).toBeCloseTo(1, 5);
	});

	it("起点{3,3}は4人集合を作らない(人数条件・F4b設計 §2.1)", async () => {
		const { origin, others } = await setupFour({
			participantsMin: 3,
			participantsMax: 3,
		});
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			others.map(entryOf),
			NOW,
		);
		expect(prep?.sets).toHaveLength(3);
		expect(prep?.sets.every((s) => s.members.length === 3)).toBe(true);
		expect(prep?.rows.size).toBe(6);
	});

	it("候補2人の間にblocks行があれば、その2人を含む集合が無く行もupsertしない", async () => {
		const { origin, others } = await setupFour();
		const [b, c] = others;
		await db.insert(blocks).values({
			blockerUserId: b.userId,
			blockedUserId: c.userId,
			createdAt: NOW,
		});
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			others.map(entryOf),
			NOW,
		);
		expect(prep).not.toBeNull();
		if (prep === null) return;
		expect(prep.sets.length).toBeGreaterThan(0);
		expect(prep.sets.some((s) => contains(s.key, b.id, c.id))).toBe(false);
		expect(prep.rows.has(intentPairKey(b.id, c.id))).toBe(false);
		expect(await rowsBetween(b, c)).toHaveLength(0);
	});

	for (const outcome of ["rejected", "matched"] as const) {
		it(`候補2人の間に${outcome}の履歴があれば、その2人を含む集合が無く行もupsertしない(Review Focus 3)`, async () => {
			const { origin, others } = await setupFour();
			const [b, c] = others;
			const [low, high] =
				b.userId < c.userId ? [b.userId, c.userId] : [c.userId, b.userId];
			await db.insert(proposalHistory).values({
				id: ulid(),
				userLow: low,
				userHigh: high,
				outcome,
				latchId: null,
				createdAt: new Date(NOW.getTime() - DAY),
				updatedAt: new Date(NOW.getTime() - DAY),
			});
			const prep = await prepareGroups(
				testEnv,
				db,
				origin,
				others.map(entryOf),
				NOW,
			);
			expect(prep).not.toBeNull();
			if (prep === null) return;
			// 残る集合は{起点,b,d}・{起点,c,d}の2件(4人集合はb・cを含むため無い)
			expect(prep.sets).toHaveLength(2);
			expect(prep.sets.some((s) => contains(s.key, b.id, c.id))).toBe(false);
			expect(prep.rows.has(intentPairKey(b.id, c.id))).toBe(false);
			expect(prep.rows.size).toBe(5);
			expect(await rowsBetween(b, c)).toHaveLength(0);
		});
	}

	it("起点{2,2}はnull(Poolを作らない)", async () => {
		const { origin, others } = await setupFour();
		const prep = await prepareGroups(
			testEnv,
			db,
			{ ...origin, participantsMin: 2, participantsMax: 2 },
			others.map(entryOf),
			NOW,
		);
		expect(prep).toBeNull();
	});

	it("Poolが1件ならnull", async () => {
		const { origin, others } = await setupFour();
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			[entryOf(others[0])],
			NOW,
		);
		expect(prep).toBeNull();
	});

	it("ベクトルの無い候補はPoolから外す", async () => {
		const { origin, others } = await setupFour();
		await memoryVectorStore().deleteByIds([others[2].id]);
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			others.map(entryOf),
			NOW,
		);
		expect(prep?.poolSize).toBe(2);
		expect(prep?.sets).toHaveLength(1);
		expect(prep?.rows.size).toBe(3);
	});

	it("既存の行にjev_resultがあればrowsのjevResultに入り、行は増えない", async () => {
		const { origin, others } = await setupFour();
		const [b, c] = others;
		const [lo, hi] = b.id < c.id ? [b, c] : [c, b];
		const axes = {
			would_a_accept_b: 0.7,
			would_b_accept_a: 0.75,
			purpose_fit: 0.8,
			mood_fit: 0.8,
			timing_fit: 0.8,
			social_fit: 0.8,
			latent_yes: 0.8,
		};
		const existingId = ulid();
		await db.insert(matchCandidates).values({
			id: existingId,
			intentAId: lo.id,
			intentBId: hi.id,
			intentAVersion: 1,
			intentBVersion: 1,
			form: "connection",
			retrievalScore: 0.1,
			cheapJudgeScore: 0.1,
			jevResult: axes,
			status: "candidate",
			createdAt: new Date(NOW.getTime() - DAY),
			updatedAt: new Date(NOW.getTime() - DAY),
		});
		const prep = await prepareGroups(
			testEnv,
			db,
			origin,
			others.map(entryOf),
			NOW,
		);
		const row = prep?.rows.get(intentPairKey(b.id, c.id));
		expect(row?.id).toBe(existingId);
		expect(row?.jevResult).toEqual(axes);
		const saved = await rowsBetween(b, c);
		expect(saved).toHaveLength(1);
		// 衝突時はスコアとupdated_atのみ更新
		expect(saved[0].retrievalScore).toBeCloseTo(1, 5);
		expect(saved[0].updatedAt.getTime()).toBe(NOW.getTime());
		expect(saved[0].createdAt.getTime()).toBe(NOW.getTime() - DAY);
	});
});
