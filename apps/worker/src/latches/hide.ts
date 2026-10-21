/**
 * 表示から消す(DELETE /v1/latches/{id})と離脱後のclosedの宛先(F6a設計 §0.3の2・§2.3・§2.4)。
 * - matched: 既存のleaveで本人が抜け(1対1・下限割れは全体cancelled)、成功したらhidden_atを記録する
 * - completed・matched経由のcancelled: hidden_atの記録だけ(left_at・人数・相手の表示は変えない)
 * - 本人のhidden_atが既にあれば成功(再試行の冪等・Ruling 1)。それ以外の状態はinvalid_status
 * 内部の参照はhidden_atの本人を除外しない独自の読み出しで行う(冪等の判定に使うため)
 */

import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { latches, latchMembers, latchStatusEvents } from "../db/schema";
import { leave } from "./respond";

export type HideResult =
	| { ok: true; closedFor: "all" | "self" | "none" }
	| { ok: false; reason: "not_found" | "invalid_status" };

/** LATCHの状態と本人の参加行(本人行が無い・LATCHが無いならnull) */
const readState = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
) => {
	const [row] = await db
		.select({
			status: latches.status,
			leftAt: latchMembers.leftAt,
			hiddenAt: latchMembers.hiddenAt,
		})
		.from(latches)
		.innerJoin(
			latchMembers,
			and(
				eq(latchMembers.latchId, latches.id),
				eq(latchMembers.userId, userId),
			),
		)
		.where(eq(latches.id, latchId));
	return row ?? null;
};

/** 成立の状態記録(to_status=matched)があるか(matched経由のcancelledの判定・docs/05 §3.3) */
export const wasMatched = async (
	db: DrizzleD1Database,
	latchId: string,
): Promise<boolean> => {
	const [ev] = await db
		.select({ id: latchStatusEvents.id })
		.from(latchStatusEvents)
		.where(
			and(
				eq(latchStatusEvents.latchId, latchId),
				eq(latchStatusEvents.toStatus, "matched"),
			),
		)
		.limit(1);
	return ev !== undefined;
};

/** hidden_atを記録する(未記録のときだけ) */
const markHidden = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	now: Date,
): Promise<void> => {
	await db
		.update(latchMembers)
		.set({ hiddenAt: now })
		.where(
			and(
				eq(latchMembers.latchId, latchId),
				eq(latchMembers.userId, userId),
				isNull(latchMembers.hiddenAt),
			),
		);
};

/**
 * 離脱(leave)成功後にclosedを知らせる宛先(F6a設計 §2.4)。LATCHがcancelledになっていればnull
 * (全員の接続)、続いていれば本人の接続だけ
 */
export const closedTargetsAfterLeave = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
): Promise<string[] | null> => {
	const [row] = await db
		.select({ status: latches.status })
		.from(latches)
		.where(eq(latches.id, latchId));
	return row?.status === "cancelled" ? null : [userId];
};

/** 本人のLATCHを表示から消す(F6a設計 §2.3)。closedForはルートが知らせるclosedの宛先 */
export const hideLatch = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	now: Date,
): Promise<HideResult> => {
	let state = await readState(db, latchId, userId);
	if (state === null || state.status === "candidate") {
		return { ok: false, reason: "not_found" };
	}
	if (state.hiddenAt !== null) return { ok: true, closedFor: "none" };
	if (state.leftAt !== null) return { ok: false, reason: "not_found" };

	if (state.status === "matched") {
		const left = await leave(db, latchId, userId, now);
		if (left.ok) {
			await markHidden(db, latchId, userId, now);
			const targets = await closedTargetsAfterLeave(db, latchId, userId);
			return { ok: true, closedFor: targets === null ? "all" : "self" };
		}
		if (left.reason === "not_found") return { ok: false, reason: "not_found" };
		// 並行した状態変化(completed・他の参加者の離脱による取り消し等)で離脱できなかった。
		// 読み直して、閉じた成立後のLATCHなら表示から消すだけを行う
		state = await readState(db, latchId, userId);
		if (state === null) return { ok: false, reason: "not_found" };
		if (state.hiddenAt !== null) return { ok: true, closedFor: "none" };
		if (state.leftAt !== null) return { ok: false, reason: "not_found" };
	}

	const closedAfterMatch =
		state.status === "completed" ||
		(state.status === "cancelled" && (await wasMatched(db, latchId)));
	if (!closedAfterMatch) return { ok: false, reason: "invalid_status" };
	await markHidden(db, latchId, userId, now);
	return { ok: true, closedFor: "none" };
};
