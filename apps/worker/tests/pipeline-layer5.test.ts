/**
 * Layer 5のHard Constraint再検証(recheckHard)の統合試験(docs/06 §6)。
 * 行を直接INSERTし、候補側の状態変化・ブロック・履歴・起点の失効で除外されることを確認する。
 */
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { blocks, intents, proposalHistory, users } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { pairKey } from "../src/pipeline/layer1";
import { recheckHard } from "../src/pipeline/layer5";
import { countD1RoundTrips } from "./d1-round-trips";

const db = drizzle((env as unknown as WorkerEnv).DB);
const NOW = new Date("2026-06-01T00:00:00Z");

const insertUser = async (id: string) => {
	await db.insert(users).values({
		id,
		authProvider: "google",
		authSubject: `pipeline-layer5-${id}`,
		actorType: "individual",
		displayName: "L5試験",
		bio: "",
		birthDate: "1990-01-01",
		status: "active",
		createdAt: NOW,
		updatedAt: NOW,
	});
};

const insertIntent = async (id: string, userId: string) => {
	await db.insert(intents).values({
		id,
		userId,
		form: "connection",
		topic: "L5試験の学習仲間",
		category: null,
		rawText: "L5試験用",
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
};

/** 起点1+他者1の最小構成を作る */
const setup = async () => {
	const ou = ulid();
	const cu = ulid();
	const oi = ulid();
	const ci = ulid();
	await insertUser(ou);
	await insertUser(cu);
	await insertIntent(oi, ou);
	await insertIntent(ci, cu);
	return { ou, cu, oi, ci };
};

describe("recheckHard", () => {
	it("全条件を満たす候補は合格する", async () => {
		const { oi, ci } = await setup();
		expect([...(await recheckHard(db, oi, [ci], NOW))]).toEqual([ci]);
	});

	it("D1の直列の待ちは2段(起点と候補の行を1文で読み、残りを同時に投げる・#36)", async () => {
		const { oi, ci } = await setup();
		const counter = countD1RoundTrips((env as unknown as WorkerEnv).DB);
		const out = await recheckHard(drizzle(counter.db), oi, [ci], NOW);
		expect([...out]).toEqual([ci]);
		expect(counter.waves()).toBe(2);
	});

	it("候補側がpausedなら除外される", async () => {
		const { oi, ci } = await setup();
		await db
			.update(intents)
			.set({ status: "paused" })
			.where(eq(intents.id, ci));
		expect((await recheckHard(db, oi, [ci], NOW)).size).toBe(0);
	});

	it("blocks行が追加されると除外される", async () => {
		const { ou, cu, oi, ci } = await setup();
		await db
			.insert(blocks)
			.values({ blockerUserId: cu, blockedUserId: ou, createdAt: NOW });
		expect((await recheckHard(db, oi, [ci], NOW)).size).toBe(0);
	});

	it("proposal_history(rejected)が追加されると除外される", async () => {
		const { ou, cu, oi, ci } = await setup();
		const [low, high] = pairKey(ou, cu).split(":");
		await db.insert(proposalHistory).values({
			id: ulid(),
			userLow: low,
			userHigh: high,
			latchId: null,
			outcome: "rejected",
			createdAt: NOW,
			updatedAt: NOW,
		});
		expect((await recheckHard(db, oi, [ci], NOW)).size).toBe(0);
	});

	it("起点がexpiredなら全候補が除外される", async () => {
		const { oi, ci } = await setup();
		await db
			.update(intents)
			.set({ status: "expired" })
			.where(eq(intents.id, oi));
		expect((await recheckHard(db, oi, [ci], NOW)).size).toBe(0);
	});

	it("合格と不合格が混在しても合格分だけ返す", async () => {
		const { oi, ci } = await setup();
		const other = await setup();
		await db
			.update(intents)
			.set({ status: "paused" })
			.where(eq(intents.id, other.ci));
		const out = await recheckHard(db, oi, [ci, other.ci], NOW);
		expect([...out]).toEqual([ci]);
	});
});
