/**
 * グループ提案のクローズ後に、評価済みの次の集合を提案する(F4b設計 §3.5・docs/06 §2の(i))。
 * 新たなJevは使わず、group_candidates(status=candidate・aggregate>0.60)の中から
 * rankByAggregateの順に再検証→提案化する。毎分Cronの全体走査では行わない。
 */
import { LATCH } from "@latch/shared";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { groupCandidates, intents, latches } from "../db/schema";
import { createLogger } from "../logging/logger";
import type { IntentRow } from "../pipeline/consumer";
import { errorCodeOf } from "../pipeline/errors";
import { dedupKeyOf, rankByAggregate } from "../pipeline/group";
import { recheckSet } from "../pipeline/layer5";
import { type ProposeOutcome, proposeSet } from "./propose";

const logger = createLogger();

/** intents照会のチャンク幅(D1のバインド上限100未満) */
const INTENT_CHUNK_SIZE = 90;

/**
 * 閉じたLATCHのIntentを含む評価済みの集合から、次の1集合を提案する。
 * closedIntentIdsが3人未満(1対1)なら何もしない。proposed/heldで止め、提案しなければnull
 */
export const proposeNextGroup = async (
	db: DrizzleD1Database,
	closedIntentIds: string[],
	now: Date,
): Promise<ProposeOutcome | null> => {
	if (closedIntentIds.length < LATCH.GROUP_SIZE_MIN) return null;
	const idsJson = JSON.stringify(closedIntentIds);
	const candidates = await db
		.select()
		.from(groupCandidates)
		.where(
			and(
				eq(groupCandidates.status, "candidate"),
				gt(groupCandidates.aggregateScore, LATCH.THRESHOLD),
				sql`EXISTS (SELECT 1 FROM json_each(${groupCandidates.intentIds}) WHERE value IN (SELECT value FROM json_each(${idsJson})))`,
			),
		);
	if (candidates.length === 0) return null;

	const allIds = [...new Set(candidates.flatMap((c) => c.intentIds))];
	const byId = new Map<string, IntentRow>();
	for (let i = 0; i < allIds.length; i += INTENT_CHUNK_SIZE) {
		const rows = await db
			.select()
			.from(intents)
			.where(inArray(intents.id, allIds.slice(i, i + INTENT_CHUNK_SIZE)));
		for (const r of rows) byId.set(r.id, r);
	}

	// dedup_keyのversionが全員の現行versionと一致する集合だけを対象にする(古い評価は使わない)
	const sets = [];
	for (const c of candidates) {
		const members = c.intentIds.map((id) => byId.get(id));
		if (members.some((m) => m === undefined)) continue;
		const rows = (members as IntentRow[]).sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		);
		if (dedupKeyOf(rows) !== c.dedupKey) continue;
		sets.push({
			members: rows,
			key: rows.map((m) => m.id).join(","),
			aggregate: c.aggregateScore,
			groupCandidateId: c.id,
		});
	}

	for (const set of rankByAggregate(sets)) {
		const fresh = await recheckSet(db, set.members, now);
		if (fresh === null) continue;
		const outcome = await proposeSet(
			db,
			{
				members: fresh,
				score: set.aggregate,
				source: { kind: "group", groupCandidateId: set.groupCandidateId },
			},
			now,
		);
		if (outcome === "proposed" || outcome === "held") return outcome;
	}
	return null;
};

/**
 * クローズ済みLATCHの参加Intentから次集合を提案する(失敗は握りつぶしてログへ・
 * 成功済みのクローズ処理を壊さない)。呼び出しは各クローズ処理のreleaseHeldの直後
 */
export const proposeNextGroupAfterClose = async (
	db: DrizzleD1Database,
	latchId: string,
	now: Date,
): Promise<void> => {
	try {
		const [row] = await db
			.select({ intentIds: latches.intentIds })
			.from(latches)
			.where(eq(latches.id, latchId));
		if (row === undefined) return;
		await proposeNextGroup(db, row.intentIds, now);
	} catch (error) {
		logger.warn("cron.item.failed", {
			latch_id: latchId,
			error_code: errorCodeOf(error),
		});
	}
};
