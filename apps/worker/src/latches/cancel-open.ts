/**
 * 進行中の提案(candidate・proposed・partial_accept)の取り消し(F7a設計 §2.2の1)。
 * Intent削除(docs/05 §2.5)・active更新での意味フィールドの変更と期限の短縮(docs/01 §8の
 * 不成立経路「Hard Constraintが変化した」・docs/05 §3.2)・ブロック(F7a設計 §2.2)が共有する。
 * 対象のLATCHの照会は呼び出し側が行い(Intentを含むLATCH=openLatchIdsOfIntent・ブロックでは
 * 2人がともに参加者のLATCH=src/safety/block.tsのlatch_members自己結合)、取り消しと保留の解放は
 * cancelOpenLatches(ブロック)またはcancelOpenLatchesOnly+releaseAfterCancel(削除・内容の変更)が行う
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

/** 取り消しの結果(閉じたLATCHと、保留を解放する操作者以外の参加者) */
export interface CancelResult {
	closedLatchIds: string[];
	releaseUserIds: string[];
}

/**
 * 渡されたLATCHのうち進行中のものを cancelled で閉じるだけを行う(proposal_historyは消費しない=
 * release・提示済みなら参加者へclosed通知)。matched以降は対象の状態に含めないため変更しない。
 * 保留の解放と次集合の提案はreleaseAfterCancelで別に行う: Intentの削除・内容の変更では
 * 利用者への応答に要らないため、応答の後(waitUntil)に回す(#27)。取りこぼしは毎分Cronの
 * (i)(runHeldSweep・runNextGroupSweep)が拾い直す
 */
export const cancelOpenLatchesOnly = async (
	db: DrizzleD1Database,
	latchIds: string[],
	actorUserId: string,
	now: Date,
	opts?: { onTiming?: (layer: "cancel", startedAt: number) => void },
): Promise<CancelResult> => {
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
	return { closedLatchIds, releaseUserIds: [...affectedUserIds] };
};

/**
 * 取り消しの後始末: 操作者以外の参加者の保留を解放し(空なら呼ばない)、閉じたグループ提案ごとに
 * 評価済みの次の集合を提案する(F4b設計 §3.5)。Intent削除では、Intent行とそのグループ候補を
 * 消した後に呼ぶ(消す前に呼ぶと、削除中のIntentを含む集合が版の照合と再検証を通って提案され得る)
 */
export const releaseAfterCancel = async (
	db: DrizzleD1Database,
	result: CancelResult,
	now: Date,
	opts?: {
		onTiming?: (layer: "release" | "next_group", startedAt: number) => void;
	},
): Promise<void> => {
	if (result.releaseUserIds.length > 0) {
		const releaseStartedAt = systemClock.now().getTime();
		await releaseHeld(db, now, result.releaseUserIds);
		opts?.onTiming?.("release", releaseStartedAt);
	}
	const nextGroupStartedAt = systemClock.now().getTime();
	await proposeNextGroupsAfterCancel(db, result.closedLatchIds, now);
	opts?.onTiming?.("next_group", nextGroupStartedAt);
};

/**
 * 渡されたLATCHのうち進行中のものを cancelled で閉じ、操作者以外の参加者の保留を解放する
 * (応答の前に解放まで済ませる・ブロックが使う)。閉じたLATCHのidを返す。
 * 次集合の提案(F4b設計 §3.5)は呼び出し側がproposeNextGroupsAfterCancelで行う
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
	const result = await cancelOpenLatchesOnly(db, latchIds, actorUserId, now, {
		onTiming: opts?.onTiming,
	});
	if (result.releaseUserIds.length > 0) {
		const releaseStartedAt = systemClock.now().getTime();
		await releaseHeld(db, now, result.releaseUserIds);
		opts?.onTiming?.("release", releaseStartedAt);
	}
	return result.closedLatchIds;
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
