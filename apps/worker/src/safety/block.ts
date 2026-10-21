/**
 * ブロック(F7a設計 §2.1〜§2.3・オーナー裁定2・3)。
 * - 対象は自分と同じLATCHに成立後の参加者として居たことがある相手(matched・completed・
 *   matched経由のcancelled)に限る。該当しない・存在しない・退会済みは一律not_found
 * - blocks行を先に書き込み(既にあれば何もしない)、その後で効果を順に適用する。行が先に
 *   書かれるため、適用中に別の評価が作ろうとした提案はproposeSetの照合で作られない(§2.4)
 * - 効果: (1) 2人を含む進行中の提案の取り消し(履歴を消費しない) (2) 2人がともに参加を続ける
 *   matchedのLATCHからのブロックした本人の離脱(leave)。completed・cancelledは変えない
 * - 各効果は対象が既に閉じていれば何もしないため、再送(既にブロック済み)でも同じ適用を行う
 * 2人の共有LATCHの照会はlatch_membersの自己結合で行う(1人の相手との共有に限られるためチャンク化しない)
 */

import type { BlockDTO, LatchStatus } from "@latch/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { blocks, latches, latchMembers, users } from "../db/schema";
import {
	cancelOpenLatches,
	proposeNextGroupsAfterCancel,
} from "../latches/cancel-open";
import { wasMatched } from "../latches/hide";
import { leave } from "../latches/respond";

export type BlockOutcome =
	| { ok: true; created: boolean; leftLatchIds: string[] }
	| { ok: false; reason: "not_found" | "self_block" };

/** 退会済みの相手の一覧での表示名(F7a設計 §2.1・prototype README §7 #2) */
const DELETED_DISPLAY_NAME = "つながっていた相手";

/** 取り消しの対象になる進行中の状態(F7a設計 §2.2の1) */
const OPEN_STATUSES: LatchStatus[] = [
	"candidate",
	"proposed",
	"partial_accept",
];

/**
 * 2人がともにlatch_membersに居るLATCHのうち、状態がstatusesのもの。
 * activeOnly=trueなら2人ともleft_atなし(参加を続けている)に限る
 */
const sharedLatches = async (
	db: DrizzleD1Database,
	userA: string,
	userB: string,
	statuses: LatchStatus[],
	activeOnly: boolean,
): Promise<{ id: string; status: LatchStatus }[]> => {
	const other = alias(latchMembers, "other_member");
	return db
		.select({ id: latches.id, status: latches.status })
		.from(latchMembers)
		.innerJoin(
			other,
			and(
				eq(other.latchId, latchMembers.latchId),
				eq(other.userId, userB),
				activeOnly ? isNull(other.leftAt) : undefined,
			),
		)
		.innerJoin(latches, eq(latches.id, latchMembers.latchId))
		.where(
			and(
				eq(latchMembers.userId, userA),
				activeOnly ? isNull(latchMembers.leftAt) : undefined,
				inArray(latches.status, statuses),
			),
		);
};

/** 相手がactiveで、成立後のLATCH(matched・completed・matched経由のcancelled)を共有しているか */
const isBlockable = async (
	db: DrizzleD1Database,
	blockerId: string,
	targetId: string,
): Promise<boolean> => {
	const [target] = await db
		.select({ status: users.status })
		.from(users)
		.where(eq(users.id, targetId));
	if (target?.status !== "active") return false;
	const shared = await sharedLatches(
		db,
		blockerId,
		targetId,
		["matched", "completed", "cancelled"],
		false,
	);
	for (const l of shared) {
		if (l.status !== "cancelled") return true;
		if (await wasMatched(db, l.id)) return true;
	}
	return false;
};

/**
 * ブロックする(F7a設計 §2.1・§2.2)。leftLatchIdsは本人が離脱できたmatchedのLATCHで、
 * ルートがそれぞれへclosedを知らせる(F6a設計 §2.4と同じ宛先)
 */
export const blockUser = async (
	db: DrizzleD1Database,
	blockerId: string,
	targetId: string,
	now: Date,
): Promise<BlockOutcome> => {
	if (blockerId === targetId) return { ok: false, reason: "self_block" };
	if (!(await isBlockable(db, blockerId, targetId))) {
		return { ok: false, reason: "not_found" };
	}

	// blocks行を効果より先に書く(F7a設計 §2.2・§2.4)。既にあれば何もしない
	const inserted = await db
		.insert(blocks)
		.values({
			blockerUserId: blockerId,
			blockedUserId: targetId,
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning({ blockedUserId: blocks.blockedUserId });

	// (1) 2人を含む進行中の提案の取り消し(グループの提案も全体を閉じる)
	const open = await sharedLatches(
		db,
		blockerId,
		targetId,
		OPEN_STATUSES,
		false,
	);
	const closed = await cancelOpenLatches(
		db,
		open.map((l) => l.id),
		blockerId,
		now,
	);
	await proposeNextGroupsAfterCancel(db, closed, now);

	// (2) 2人がともに参加を続けるmatchedからの本人の離脱(オーナー裁定2・3)
	const matched = await sharedLatches(
		db,
		blockerId,
		targetId,
		["matched"],
		true,
	);
	const leftLatchIds: string[] = [];
	for (const l of matched) {
		const left = await leave(db, l.id, blockerId, now);
		if (left.ok) leftLatchIds.push(l.id);
	}

	return { ok: true, created: inserted.length > 0, leftLatchIds };
};

/** ブロックを解除する(F7a設計 §2.3)。対象の判定は行わず、行が無ければ何もしない */
export const unblockUser = async (
	db: DrizzleD1Database,
	blockerId: string,
	targetId: string,
): Promise<void> => {
	await db
		.delete(blocks)
		.where(
			and(
				eq(blocks.blockerUserId, blockerId),
				eq(blocks.blockedUserId, targetId),
			),
		);
};

/** 自分のブロック一覧(新しい順・F7a設計 §2.1)。退会済みの相手は表示名を置き換えアイコンを出さない */
export const listBlocks = async (
	db: DrizzleD1Database,
	blockerId: string,
): Promise<BlockDTO[]> => {
	const rows = await db
		.select({
			userId: blocks.blockedUserId,
			createdAt: blocks.createdAt,
			displayName: users.displayName,
			iconKey: users.iconKey,
			status: users.status,
		})
		.from(blocks)
		.innerJoin(users, eq(users.id, blocks.blockedUserId))
		.where(eq(blocks.blockerUserId, blockerId))
		.orderBy(desc(blocks.createdAt), desc(blocks.blockedUserId));
	return rows.map((r) => {
		const deleted = r.status !== "active";
		return {
			user_id: r.userId,
			display_name: deleted ? DELETED_DISPLAY_NAME : r.displayName,
			has_icon: deleted ? false : r.iconKey !== null,
			created_at: r.createdAt.toISOString(),
		};
	});
};
