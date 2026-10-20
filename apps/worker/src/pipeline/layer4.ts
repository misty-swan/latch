/**
 * Layer 4: Jev対象の選択・jev_resultの再利用と保存(設計書 §2.3・docs/06 §5)。
 * Layer 3降順の候補のうち、match_candidates.jev_resultが既にある行は再利用し(Jevを呼ばない)、
 * 無い行だけをJev実行器へ渡して結果を同じ行へ保存する。
 * JevInputは行の正規化順(intent_a=小さいid側)で作り、起点の向きに依存させない。
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { type intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { type JevRunResult, type JevTarget, runJev } from "../jev/runner";
import { createLlm } from "../llm/mode";
import type { JevAxes } from "../llm/types";
import { buildNormalizedText } from "./normalize";

type IntentRow = typeof intents.$inferSelect;

export interface L4Candidate {
	/** match_candidates.id */
	rowId: string;
	origin: IntentRow;
	other: IntentRow;
	cheapScore: number;
}

export interface L4Result {
	/** 行id→7軸(再利用分+今回の実行分) */
	axesByRow: Map<string, JevAxes>;
	reused: number;
	run: JevRunResult;
}

export const runLayer4 = async (
	env: Env,
	clock: Clock,
	candidates: L4Candidate[],
): Promise<L4Result> => {
	const db = drizzle(env.DB);
	const axesByRow = new Map<string, JevAxes>();
	const first = candidates[0];
	if (!first) {
		return {
			axesByRow,
			reused: 0,
			run: {
				axes: new Map(),
				calls: 0,
				held: { budget: 0, breaker: 0, failed: 0, cap: 0 },
				latencyMs: 0,
			},
		};
	}

	// 既存のjev_resultと行の正規化順(intent_a側のid)を読む。候補はK_c=20以下のため1回で足りる
	const rows = await db
		.select({
			id: matchCandidates.id,
			intentAId: matchCandidates.intentAId,
			jevResult: matchCandidates.jevResult,
		})
		.from(matchCandidates)
		.where(
			inArray(
				matchCandidates.id,
				candidates.map((c) => c.rowId),
			),
		);
	const rowById = new Map(rows.map((r) => [r.id, r]));

	let reused = 0;
	const targets: JevTarget[] = [];
	for (const c of candidates) {
		const row = rowById.get(c.rowId);
		if (!row) {
			continue;
		}
		if (row.jevResult !== null) {
			axesByRow.set(c.rowId, row.jevResult as JevAxes);
			reused += 1;
			continue;
		}
		// intent_a=小さいid側。起点がどちらでも行の向きで組む
		const [a, b] =
			row.intentAId === c.origin.id ? [c.origin, c.other] : [c.other, c.origin];
		targets.push({
			key: c.rowId,
			input: {
				normalizedA: buildNormalizedText(a),
				normalizedB: buildNormalizedText(b),
			},
		});
	}

	const run = await runJev(
		{
			jev: createLlm(env as unknown as Parameters<typeof createLlm>[0], clock)
				.jev,
			db,
			kv: env.PIPELINE_KV,
			clock,
		},
		{ intentId: first.origin.id, userId: first.origin.userId },
		targets,
	);

	const now = clock.now();
	for (const [rowId, axes] of run.axes) {
		await db
			.update(matchCandidates)
			.set({ jevResult: axes, updatedAt: now })
			.where(eq(matchCandidates.id, rowId));
		axesByRow.set(rowId, axes);
	}
	return { axesByRow, reused, run };
};
