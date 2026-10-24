/**
 * 進行中の提案(candidate・proposed・partial_accept)の取り消し(F7a設計 §2.2の1)。
 * Intent削除(docs/05 §2.5)・active更新での意味フィールドの変更と期限の短縮(docs/01 §8の
 * 不成立経路「Hard Constraintが変化した」・docs/05 §3.2)・ブロック(F7a設計 §2.2)が共有する。
 * 対象のLATCHの照会は呼び出し側が行い(Intentを含むLATCH=openLatchIdsOfIntent・ブロックでは
 * 2人がともに参加者のLATCH=src/safety/block.tsのlatch_members自己結合)、取り消しと保留の解放は
 * cancelOpenLatchesが行う
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { systemClock } from "../clock/clock";
import { latches, latchMembers } from "../db/schema";
import { closeLatch } from "./close";
import { proposeNextGroupAfterClose } from "./next-group";
import { releaseHeld } from "./release";

/** 取り消しの対象になる進行中の状態 */
const OPEN_STATUSES = ["candidate", "proposed", "partial_accept"] as const;

/** 指定Intentを含む進行中の提案(candidate・proposed・partial_accept)のid */
export const openLatchIdsOfIntent = async (
	db: DrizzleD1Database,
	intentId: string,
): Promise<string[]> => {
	const rows = await db
		.select({ id: latches.id })
		.from(latches)
		.where(
			and(
				inArray(latches.status, [...OPEN_STATUSES]),
				sql`EXISTS (SELECT 1 FROM json_each(${latches.intentIds}) WHERE json_each.value = ${intentId})`,
			),
		);
	return rows.map((r) => r.id);
};

/**
 * 渡されたLATCHのうち進行中のものを cancelled で閉じ(proposal_historyは消費しない=release・
 * 提示済みなら参加者へclosed通知)、操作者以外の参加者の保留を解放する。
 * matched以降は対象の状態に含めないため変更しない。閉じたLATCHのidを返す。
 * 次集合の提案(F4b設計 §3.5)は呼び出し側がproposeNextGroupsAfterCancelで行う: Intent削除では
 * Intent行とそのグループ候補を消した後に呼ぶ(消す前に呼ぶと、削除中のIntentを含む集合が
 * 版の照合と再検証を通って提案され得る)
 */
export const cancelOpenLatches = async (
	db: DrizzleD1Database,
	latchIds: string[],
	actorUserId: string,
	now: Date,
	opts?: {
		onTiming?: (layer: "cancel" | "release", startedAt: number) => void;
	},
): Promise<string[]> => {
	// 所要時間は呼び出し側が渡す計測の関数へ通す(取り消しと保留の解放を分けて測る・#27)
	const cancelStartedAt = systemClock.now().getTime();
	const affectedUserIds = new Set<string>();
	const closedLatchIds: string[] = [];
	for (const id of latchIds) {
		// システムの都合の閉じ方のため履歴を消費しない(オーナー裁定 2026-10-20・F7a設計 §2.2)
		const closed = await closeLatch(
			db,
			id,
			"cancelled",
			{ kind: "release" },
			[...OPEN_STATUSES],
			now,
		);
		if (!closed) continue;
		closedLatchIds.push(id);
		const members = await db
			.select({ userId: latchMembers.userId })
			.from(latchMembers)
			.where(eq(latchMembers.latchId, id));
		for (const m of members) affectedUserIds.add(m.userId);
	}
	opts?.onTiming?.("cancel", cancelStartedAt);
	// 操作者以外の参加者は、解放された枠で保留の提案が進められるようにする
	affectedUserIds.delete(actorUserId);
	if (affectedUserIds.size > 0) {
		const releaseStartedAt = systemClock.now().getTime();
		await releaseHeld(db, now, [...affectedUserIds]);
		opts?.onTiming?.("release", releaseStartedAt);
	}
	return closedLatchIds;
};

/** 閉じたグループ提案ごとに、評価済みの次の集合を提案する(F4b設計 §3.5) */
export const proposeNextGroupsAfterCancel = async (
	db: DrizzleD1Database,
	closedLatchIds: string[],
	now: Date,
): Promise<void> => {
	for (const id of closedLatchIds) {
		await proposeNextGroupAfterClose(db, id, now);
	}
};
