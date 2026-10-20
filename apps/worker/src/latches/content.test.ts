/**
 * 提案の中身の単体試験(F4a設計 §3.6)。
 */

import { latchProposalSchema } from "@latch/shared";
import { describe, expect, it } from "vitest";
import type { intents } from "../db/schema";
import { baseIntentOf, buildProposal } from "./content";

type Row = typeof intents.$inferSelect;

const at = (hhmm: string): Date => new Date(`2026-06-01T${hhmm}:00Z`);

const row = (overrides: Partial<Row>): Row =>
	({
		id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
		form: "occasion",
		topic: "主題A",
		startsAt: null,
		endsAt: null,
		expiresAt: null,
		participantsMin: 2,
		participantsMax: 4,
		budgetMin: null,
		budgetMax: null,
		createdAt: at("08:00"),
		...overrides,
	}) as Row;

describe("baseIntentOf", () => {
	it("created_atの早い方", () => {
		const early = row({ id: "01B", createdAt: at("08:00") });
		const late = row({ id: "01A", createdAt: at("09:00") });
		expect(baseIntentOf([early, late])).toBe(early);
		expect(baseIntentOf([late, early])).toBe(early);
	});

	it("同値はid昇順", () => {
		const a = row({ id: "01A" });
		const b = row({ id: "01B" });
		expect(baseIntentOf([b, a])).toBe(a);
		expect(baseIntentOf([a, b])).toBe(a);
	});

	it("3人: created_at最小", () => {
		const early = row({ id: "01C", createdAt: at("07:00") });
		const late = row({ id: "01A", createdAt: at("09:00") });
		const mid = row({ id: "01B", createdAt: at("08:00") });
		expect(baseIntentOf([late, early, mid])).toBe(early);
	});
});

describe("buildProposal", () => {
	const occasionA = row({
		id: "01A",
		topic: "先に預けた側",
		createdAt: at("08:00"),
		startsAt: at("12:00"),
		endsAt: at("15:00"),
		expiresAt: at("16:00"),
		participantsMin: 2,
		participantsMax: 4,
		budgetMin: 1000,
		budgetMax: 5000,
	});
	const occasionB = row({
		id: "01B",
		topic: "後から預けた側",
		createdAt: at("09:00"),
		startsAt: at("13:00"),
		endsAt: null,
		expiresAt: at("14:00"),
		participantsMin: 3,
		participantsMax: 6,
		budgetMin: 3000,
		budgetMax: 8000,
	});

	it("機会: 主題は先に預けた側・時間は重なり・人数と予算は共通部分", () => {
		const expected = {
			form: "occasion",
			topic: "先に預けた側",
			time_window: {
				start: "2026-06-01T13:00:00.000Z",
				// Bはends_at未設定なのでexpires_at(14:00)が終端
				end: "2026-06-01T14:00:00.000Z",
			},
			region_name: "渋谷",
			participants: { min: 3, max: 4 },
			budget: { min: 3000, max: 5000 },
		};
		// 引数の順序に依らない
		expect(buildProposal([occasionA, occasionB], "渋谷")).toEqual(expected);
		expect(buildProposal([occasionB, occasionA], "渋谷")).toEqual(expected);
		expect(latchProposalSchema.safeParse(expected).success).toBe(true);
	});

	it("予算は片方がnullまたは共通部分が空ならnull", () => {
		expect(
			buildProposal(
				[occasionA, row({ ...occasionB, budgetMin: null, budgetMax: null })],
				null,
			).budget,
		).toBeNull();
		expect(
			buildProposal(
				[occasionA, row({ ...occasionB, budgetMin: 6000, budgetMax: 8000 })],
				null,
			).budget,
		).toBeNull();
	});

	it("人数の共通部分が空なら基準Intent側の値(防御)", () => {
		const b = row({ ...occasionB, participantsMin: 5, participantsMax: 6 });
		expect(buildProposal([occasionA, b], null).participants).toEqual({
			min: 2,
			max: 4,
		});
	});

	it("つながり: time_windowとbudgetはnull", () => {
		const a = row({
			id: "01A",
			form: "connection",
			topic: "先",
			budgetMin: 1000,
			budgetMax: 2000,
		});
		const b = row({
			id: "01B",
			form: "connection",
			topic: "後",
			createdAt: at("09:00"),
			participantsMin: 2,
			participantsMax: 3,
			budgetMin: 1000,
			budgetMax: 2000,
		});
		const p = buildProposal([a, b], null);
		expect(p).toEqual({
			form: "connection",
			topic: "先",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 3 },
			budget: null,
		});
		expect(latchProposalSchema.safeParse(p).success).toBe(true);
	});

	it("3人: 時間は全員の共通部分・人数は全員の共通部分・誰かが予算なしならbudgetはnull", () => {
		const mk = (
			id: string,
			start: string,
			end: string,
			pMin: number,
			pMax: number,
			budget: [number, number] | null,
		) =>
			row({
				id,
				startsAt: at(start),
				endsAt: at(end),
				expiresAt: at("20:00"),
				participantsMin: pMin,
				participantsMax: pMax,
				budgetMin: budget?.[0] ?? null,
				budgetMax: budget?.[1] ?? null,
			});
		const a = mk("01A", "12:00", "15:00", 2, 4, [1000, 5000]);
		const b = mk("01B", "12:30", "14:00", 3, 4, [1000, 5000]);
		const c = mk("01C", "13:00", "14:30", 3, 3, null);
		const p = buildProposal([a, b, c], null);
		expect(p.time_window).toEqual({
			start: "2026-06-01T13:00:00.000Z",
			end: "2026-06-01T14:00:00.000Z",
		});
		expect(p.participants).toEqual({ min: 3, max: 3 });
		expect(p.budget).toBeNull();
		expect(latchProposalSchema.safeParse(p).success).toBe(true);
	});
});
