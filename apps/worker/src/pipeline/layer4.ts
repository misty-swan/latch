/**
 * Layer 4: Jev対象の選択・jev_resultの再利用と保存(設計書 §2.3・docs/06 §5)。
 * Layer 3降順の候補のうち、match_candidates.jev_resultが既にある行は再利用し(Jevを呼ばない)、
 * 無い行だけをJev実行器へ渡して結果を同じ行へ保存する。
 * JevInputは行の正規化順(intent_a=小さいid側)で作り、起点の向きに依存させない。
 * 1対1とグループ(他人どうしのペアを含む)の対象を1つの列で受け取り、予算は
 * 明示した起点(evaluateIntentの対象)へ計上する(F4b設計 §2.4)。
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type Clock, systemClock } from "../clock/clock";
import { type intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import {
	type JevRunResult,
	type JevTarget,
	type JevTimingLabel,
	runJev,
} from "../jev/runner";
import { createLlm } from "../llm/mode";
import type { JevAxes, JevFn } from "../llm/types";
import { buildNormalizedText } from "./normalize";

type IntentRow = typeof intents.$inferSelect;

export interface L4Candidate {
	/** match_candidates.id */
	rowId: string;
	/** ペアの一方(1対1は起点・他人どうしは行のa側)。JevInputの向きは行で決める */
	origin: IntentRow;
	other: IntentRow;
}

export interface L4Result {
	/** 行id→7軸(再利用分+今回の実行分) */
	axesByRow: Map<string, JevAxes>;
	reused: number;
	run: JevRunResult;
	/**
	 * 段ごとの実時間(ミリ秒・#36の記録用)。pre=既存jev_resultの読み込みと対象の組み立て、
	 * call=Jev実行器(予算の確保・circuit breaker・外部送信の集計を含む呼び出し)、
	 * post=得た結果のjev_resultへの保存
	 */
	timingsMs: { pre: number; call: number; post: number };
	/** callの内訳(全波の合計・ミリ秒)。breaker確認・予算確保・外部呼び出し・breaker記録 */
	callBreakdownMs: Record<JevTimingLabel, number>;
}

const emptyBreakdown = (): Record<JevTimingLabel, number> => ({
	jev_breaker: 0,
	jev_reserve: 0,
	jev_http: 0,
	jev_record: 0,
});

export const runLayer4 = async (
	env: Env,
	clock: Clock,
	// 予算の起点(評価対象のIntent)。他人どうしのペアが混ざるため候補からは取らない
	budgetOrigin: { intentId: string; userId: string },
	candidates: L4Candidate[],
	// 試験で入力の向きを記録できるよう差し替え可能にする(既定は設定どおりのJev)
	jev: { primary: JevFn; fallback: JevFn } = createLlm(
		env as unknown as Parameters<typeof createLlm>[0],
		clock,
	).jev,
): Promise<L4Result> => {
	const db = drizzle(env.DB);
	// 段の所要時間は実時間で測る(渡されたClockは試験で止まっているため・#36)
	const preStartedAt = systemClock.now().getTime();
	const axesByRow = new Map<string, JevAxes>();
	if (candidates.length === 0) {
		return {
			axesByRow,
			reused: 0,
			run: {
				axes: new Map(),
				calls: 0,
				held: { budget: 0, breaker: 0, failed: 0, cap: 0 },
				latencyMs: 0,
			},
			timingsMs: { pre: 0, call: 0, post: 0 },
			callBreakdownMs: emptyBreakdown(),
		};
	}

	// 既存のjev_resultと行の正規化順(intent_a側のid)を読む。候補は1対1(K_c=20以下)+
	// グループ用の新規分(K_j=8以下)のため1回で足りる(D1のバインド上限100未満)
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

	const callStartedAt = systemClock.now().getTime();
	const callBreakdownMs = emptyBreakdown();
	const run = await runJev(
		{
			jev,
			db,
			kv: env.PIPELINE_KV,
			clock,
			onTiming: (label, ms) => {
				callBreakdownMs[label] += ms;
			},
		},
		budgetOrigin,
		targets,
	);

	const postStartedAt = systemClock.now().getTime();
	const now = clock.now();
	// 行ごとのUPDATEは互いに独立のため1つのバッチ(1往復)で書く(#36)
	const writes = [...run.axes].map(([rowId, axes]) =>
		db
			.update(matchCandidates)
			.set({ jevResult: axes, updatedAt: now })
			.where(eq(matchCandidates.id, rowId)),
	);
	if (writes.length > 0) {
		const [first, ...rest] = writes;
		await db.batch([first, ...rest]);
	}
	for (const [rowId, axes] of run.axes) {
		axesByRow.set(rowId, axes);
	}
	return {
		axesByRow,
		reused,
		run,
		callBreakdownMs,
		timingsMs: {
			pre: callStartedAt - preStartedAt,
			call: postStartedAt - callStartedAt,
			post: systemClock.now().getTime() - postStartedAt,
		},
	};
};
