/**
 * グループ評価の準備(prepareGroups・F4b設計 §2.2〜§2.4)の統合試験。
 * 行を直接INSERTし、インメモリのベクトルストアへ直接upsertして呼ぶ。
 * - Pool内の他人どうしのペアのHard判定(blocks・提案履歴の恒久排除・Review Focus 3)
 * - 集合に現れるペアだけのmatch_candidates行のupsertと、既存jev_resultの返却
 * - evaluateIntentへの統合(人数条件・Jev配分・集合の提案・失敗の隔離・F4b設計 §2.4〜§5)
 */
import {
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
} from "cloudflare:test";
import type { MatchQueueMessage } from "@latch/shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock/clock";
import {
	blocks,
	groupCandidates,
	intents,
	latches,
	latchMembers,
	matchCandidates,
	matchEvents,
	proposalHistory,
	users,
} from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { stubEmbedding } from "../src/llm/stub/embedding";
import { stubJev } from "../src/llm/stub/jev";
import type { JevFn, JevInput } from "../src/llm/types";
import { handleQueueBatch, type IntentRow } from "../src/pipeline/consumer";
import { evaluateIntent } from "../src/pipeline/evaluate";
import {
	dedupKeyOf,
	intentPairKey,
	type PoolEntry,
} from "../src/pipeline/group";
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

/** 指定Intent群の誰かが参加するLATCHの一覧(latch_members経由・重複なし) */
const latchesAmong = async (members: IntentRow[]) => {
	const rows = await db
		.select()
		.from(latchMembers)
		.where(
			inArray(
				latchMembers.userId,
				members.map((m) => m.userId),
			),
		);
	const ids = [...new Set(rows.map((r) => r.latchId))];
	if (ids.length === 0) return [];
	return db.select().from(latches).where(inArray(latches.id, ids));
};

/** LATCHの参加ユーザーid(昇順) */
const membersOf = async (latchId: string): Promise<string[]> =>
	(
		await db
			.select()
			.from(latchMembers)
			.where(eq(latchMembers.latchId, latchId))
	)
		.map((m) => m.userId)
		.sort();

/** 入力が2つのIntentの組か(向きは問わない) */
const isPair = (input: JevInput, a: IntentRow, b: IntentRow): boolean => {
	const ta = buildNormalizedText(a);
	const tb = buildNormalizedText(b);
	return (
		(input.normalizedA === ta && input.normalizedB === tb) ||
		(input.normalizedA === tb && input.normalizedB === ta)
	);
};

/** 入力を記録してstubへ委ねるJev */
const recordingJev = () => {
	const seen: JevInput[] = [];
	const fn: JevFn = async (input) => {
		seen.push(input);
		return stubJev(input);
	};
	return { seen, jev: { primary: fn, fallback: fn } };
};

/** 起点のembedding_completedイベントをconsumerで消費し、payloadを返す */
const consumeCompleted = async (
	intentId: string,
	clock = fixedClock(NOW),
): Promise<Record<string, unknown>> => {
	const eventId = ulid();
	await db.insert(matchEvents).values({
		id: eventId,
		eventType: "embedding_completed",
		sourceIntentId: intentId,
		version: 1,
		payload: {},
		status: "pending",
		createdAt: NOW,
	});
	const batch = createMessageBatch<MatchQueueMessage>("match-events", [
		{
			id: "msg-0",
			timestamp: new Date(),
			attempts: 1,
			body: { event_id: eventId },
		},
	]);
	const ctx = createExecutionContext();
	await handleQueueBatch(batch, testEnv, ctx, clock);
	await getQueueResult(batch, ctx);
	const [event] = await db
		.select()
		.from(matchEvents)
		.where(eq(matchEvents.id, eventId));
	expect(event?.status).toBe("processed");
	return event?.payload as Record<string, unknown>;
};

/** 名前付きtopicのIntent(正規化テキストを互いに異ならせる) */
const named = (label: string, overrides: Partial<IntentRow> = {}) =>
	insertIntent({ topic: `グループ評価試験の学習仲間${label}`, ...overrides });

describe("evaluateIntentへのグループ統合(F4b設計 §2.4〜§2.5・§5)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("3人のつながり{3,3}: A・Bを置いてCを評価すると3人のLATCHがproposedになる", async () => {
		const only3 = { participantsMin: 3, participantsMax: 3 };
		const a = await named("A", only3);
		const b = await named("B", only3);
		const c = await named("C", only3);

		const payload = await consumeCompleted(c.id);
		expect(payload).toMatchObject({
			l4_skipped_participants: 2,
			group_pool: 2,
			group_sets: 1,
			group_jev_calls: 3,
			group_held_sets: 0,
			group_over_threshold: 1,
			group_proposed: 1,
			group_held_proposals: 0,
			group_failed: 0,
			proposed: 0,
		});
		expect(payload.jev_calls as number).toBeLessThanOrEqual(8);
		expect(payload.jev_calls).toBe(3);

		const found = await latchesAmong([a, b, c]);
		expect(found).toHaveLength(1);
		expect(found[0].status).toBe("proposed");
		expect(await membersOf(found[0].id)).toEqual(
			[a.userId, b.userId, c.userId].sort(),
		);
		const [group] = await db
			.select()
			.from(groupCandidates)
			.where(eq(groupCandidates.dedupKey, dedupKeyOf([a, b, c])));
		expect(group?.status).toBe("proposed");
		expect(group?.aggregateScore).toBeGreaterThan(0.6);
		// 他人どうし(A-B)の行にもjev_resultとlatch_scoreが保存される
		const [ab] = await rowsBetween(a, b);
		expect(ab.jevResult).not.toBeNull();
		expect(ab.latchScore).toBeGreaterThan(0.6);
	});

	it("起点{2,4}・1対1候補10件・3人集合あり: Jevは8回以内で1対1は5件以上", async () => {
		const both = { participantsMin: 2, participantsMax: 4 };
		const origin = await named("O", both);
		const others: IntentRow[] = [];
		for (let i = 0; i < 10; i++) {
			others.push(await named(String(i).padStart(2, "0"), both));
		}
		const { seen, jev } = recordingJev();
		const result = await evaluateIntent(testEnv, origin.id, fixedClock(NOW), {
			jev,
		});
		expect(result).not.toBeNull();
		if (result === null) return;
		expect(result.l4SkippedParticipants).toBe(0);
		expect(result.groupSets).toBeGreaterThan(0);
		expect(result.groupJevCalls).toBeGreaterThanOrEqual(1);
		expect(result.jevCalls).toBeLessThanOrEqual(8);
		expect(seen.length).toBeLessThanOrEqual(8);
		const originText = buildNormalizedText(origin);
		const oneOnOne = seen.filter(
			(s) => s.normalizedA === originText || s.normalizedB === originText,
		);
		expect(oneOnOne.length).toBeGreaterThanOrEqual(5);
		// 枠に収まらない1対1はcapとして数える(10件のうちJevへ渡らなかった分)
		expect(result.jevHeld.cap).toBe(10 - oneOnOne.length);
	});

	it("Jevの1ペアだけ両方timeout → 集合は保留し、次の評価でそのペアだけ呼んで提案する", async () => {
		const only3 = { participantsMin: 3, participantsMax: 3 };
		const a = await named("A", only3);
		const b = await named("B", only3);
		const c = await named("C", only3);
		const failing: JevFn = async (input) =>
			isPair(input, a, b) ? { ok: false, kind: "timeout" } : stubJev(input);

		const first = await evaluateIntent(testEnv, c.id, fixedClock(NOW), {
			jev: { primary: failing, fallback: failing },
		});
		expect(first?.groupProposed).toBe(0);
		expect(first?.groupHeldSets).toBeGreaterThanOrEqual(1);
		expect(first?.jevHeld.failed).toBe(1);
		expect(await latchesAmong([a, b, c])).toHaveLength(0);

		// 30分抑制の後・同じversionで再評価する
		const { seen, jev } = recordingJev();
		const second = await evaluateIntent(
			testEnv,
			c.id,
			fixedClock(new Date(NOW.getTime() + 31 * 60_000)),
			{ jev },
		);
		expect(seen).toHaveLength(1);
		expect(isPair(seen[0], a, b)).toBe(true);
		// 既存のjev_result(A-C・B-C)は集合の点数へ再利用し、Jevへは渡さない
		expect(second?.jevCalls).toBe(1);
		expect(second?.groupJevCalls).toBe(1);
		expect(second?.groupProposed).toBe(1);
		const found = await latchesAmong([a, b, c]);
		expect(found).toHaveLength(1);
		expect(await membersOf(found[0].id)).toEqual(
			[a.userId, b.userId, c.userId].sort(),
		);
	});

	it("Jev実行後に集合の1人がpausedになると、その集合は提案せず次の集合へ進む(Review Focus 5)", async () => {
		const origin = await named("O");
		const others = [await named("X"), await named("Y"), await named("Z")];
		// 最初に並ぶ集合は他の3人のうち最小idの人を必ず含む(同点はkey昇順)
		const sorted = [...others].sort((p, q) => (p.id < q.id ? -1 : 1));
		const paused = sorted[0];
		const pausingJev: JevFn = async (input) => {
			await db
				.update(intents)
				.set({ status: "paused" })
				.where(eq(intents.id, paused.id));
			return stubJev(input);
		};
		const result = await evaluateIntent(testEnv, origin.id, fixedClock(NOW), {
			jev: { primary: pausingJev, fallback: pausingJev },
		});
		expect(result?.groupSets).toBe(4);
		expect(result?.groupOverThreshold).toBe(4);
		expect(result?.groupProposed).toBe(1);
		const found = await latchesAmong([origin, ...others]);
		expect(found).toHaveLength(1);
		expect(await membersOf(found[0].id)).toEqual(
			[origin.userId, sorted[1].userId, sorted[2].userId].sort(),
		);
	});

	it("prepareGroupsが例外でも1対1の提案は作られ、評価は結果を返す", async () => {
		const both = { participantsMin: 2, participantsMax: 3 };
		const origin = await named("O", both);
		await named("X", both);
		await named("Y", both);
		const store = memoryVectorStore();
		const original = store.getByIds.bind(store);
		// 1回目(起点のベクトル)は通し、2回目(Pool全員のベクトル)で失敗させる
		vi.spyOn(store, "getByIds")
			.mockImplementationOnce(original)
			.mockRejectedValueOnce(new Error("VECTOR_DOWN: boom"));
		const logSpy = vi.spyOn(console, "log");

		const result = await evaluateIntent(testEnv, origin.id, fixedClock(NOW));
		expect(result).not.toBeNull();
		expect(result?.proposed).toBe(2);
		expect(result?.groupProposed).toBe(0);
		expect(result?.groupFailed).toBe(1);
		const warned = logSpy.mock.calls
			.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
			.filter((line) => line.event === "pipeline.group.failed");
		expect(warned).toEqual([
			{
				level: "warn",
				event: "pipeline.group.failed",
				intent_id: origin.id,
				error_code: "VECTOR_DOWN",
			},
		]);
	});

	it("Jev実行後に集合の1人のversionが変わると、その集合は提案せず次の集合へ進む", async () => {
		const origin = await named("O");
		const others = [await named("X"), await named("Y"), await named("Z")];
		// 最初に並ぶ集合は他の3人のうち最小idの人を必ず含む(同点はkey昇順)
		const sorted = [...others].sort((p, q) => (p.id < q.id ? -1 : 1));
		const bumped = sorted[0];
		const bumpingJev: JevFn = async (input) => {
			await db
				.update(intents)
				.set({ version: bumped.version + 1 })
				.where(eq(intents.id, bumped.id));
			return stubJev(input);
		};
		const result = await evaluateIntent(testEnv, origin.id, fixedClock(NOW), {
			jev: { primary: bumpingJev, fallback: bumpingJev },
		});
		expect(result?.groupOverThreshold).toBe(4);
		expect(result?.groupProposed).toBe(1);
		const found = await latchesAmong([origin, ...others]);
		expect(found).toHaveLength(1);
		expect(await membersOf(found[0].id)).toEqual(
			[origin.userId, sorted[1].userId, sorted[2].userId].sort(),
		);
	});

	it("finishGroupsが例外でも1対1の提案とlast_evaluated_atは残り、payloadにgroup_failed=1", async () => {
		const both = { participantsMin: 2, participantsMax: 3 };
		const origin = await named("O", both);
		const x = await named("X", both);
		const y = await named("Y", both);
		// group_candidatesへの書き込みだけを失敗させる(集合の仕上げ=finishGroupsの例外)
		await testEnv.DB.exec(
			"CREATE TRIGGER fail_group_candidates BEFORE INSERT ON group_candidates BEGIN SELECT RAISE(ABORT, 'GROUP_DOWN'); END;",
		);
		const logSpy = vi.spyOn(console, "log");
		try {
			const payload = await consumeCompleted(origin.id);
			expect(payload).toMatchObject({
				proposed: 2,
				group_sets: 1,
				group_proposed: 0,
				group_failed: 1,
			});
		} finally {
			await testEnv.DB.exec("DROP TRIGGER fail_group_candidates;");
		}
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, origin.id));
		expect(row?.lastEvaluatedAt?.getTime()).toBe(NOW.getTime());
		expect(
			await db
				.select()
				.from(groupCandidates)
				.where(eq(groupCandidates.dedupKey, dedupKeyOf([origin, x, y]))),
		).toHaveLength(0);
		const warned = logSpy.mock.calls
			.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
			.filter((line) => line.event === "pipeline.group.failed");
		expect(warned).toHaveLength(1);
		// 許可リストのフィールド(intent_id・error_code)のみ
		expect(Object.keys(warned[0]).sort()).toEqual([
			"error_code",
			"event",
			"intent_id",
			"level",
		]);
		expect(warned[0].intent_id).toBe(origin.id);
		expect(typeof warned[0].error_code).toBe("string");
	});
});
