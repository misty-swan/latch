/**
 * 回答(yes/defer/no)・取り消し・離脱・見送り理由と成立後処理(F4a設計 §4.2〜§4.4・docs/05 §3.3)。
 * yesは回答の記録と状態更新を1つのD1バッチ(1トランザクション)で書き、有効なyesの数をDB内で
 * 数えて状態を決める(§4.3)。読んだ状態との照合はしないため、並行したyesの順序に依らず
 * yesが揃った時点のバッチがmatchedにする。
 */

import type { DeferReason, LatchResponseValue } from "@latch/shared";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	intents,
	latches,
	latchMembers,
	latchResponses,
	latchStatusEvents,
	notifications,
	proposalHistory,
} from "../db/schema";
import { newUlid } from "../ids";
import { closeLatch } from "./close";
import { releaseHeld } from "./release";

export type RespondFailure =
	| "not_found"
	| "invalid_status"
	| "deadline_passed"
	| "already_responded"
	| "not_deferred";
export type RespondResult =
	| { ok: true; latchId: string }
	| { ok: false; reason: RespondFailure };

type LatchRow = typeof latches.$inferSelect;
type ResponseRow = typeof latchResponses.$inferSelect;

const fail = (reason: RespondFailure): RespondResult => ({
	ok: false,
	reason,
});

const OPEN_STATUSES = ["proposed", "partial_accept"] as const;

const isOpen = (latch: LatchRow): boolean =>
	latch.status === "proposed" || latch.status === "partial_accept";

/** 回答できない理由(期限超過を優先)。回答可能ならnull */
const closedReason = (latch: LatchRow, now: Date): RespondFailure | null => {
	if (!isOpen(latch)) return "invalid_status";
	if (latch.responseDeadline.getTime() <= now.getTime()) {
		return "deadline_passed";
	}
	return null;
};

/** 参加者から見たLATCHと自分の回答。不在・非参加・保留(candidate)はnull(一律404・docs/05 §3.1) */
const loadForMember = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
): Promise<{ latch: LatchRow; mine: ResponseRow | undefined } | null> => {
	const [latch] = await db
		.select()
		.from(latches)
		.where(eq(latches.id, latchId));
	if (latch === undefined || latch.status === "candidate") return null;
	const [member] = await db
		.select({ userId: latchMembers.userId })
		.from(latchMembers)
		.where(
			and(eq(latchMembers.latchId, latchId), eq(latchMembers.userId, userId)),
		);
	if (member === undefined) return null;
	const mine = await responseOf(db, latchId, userId);
	return { latch, mine };
};

const responseOf = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
): Promise<ResponseRow | undefined> => {
	const [row] = await db
		.select()
		.from(latchResponses)
		.where(
			and(
				eq(latchResponses.latchId, latchId),
				eq(latchResponses.userId, userId),
			),
		);
	return row;
};

const membersOf = async (
	db: DrizzleD1Database,
	latchId: string,
): Promise<string[]> => {
	const rows = await db
		.select({ userId: latchMembers.userId })
		.from(latchMembers)
		.where(eq(latchMembers.latchId, latchId));
	return rows.map((r) => r.userId);
};

/** バッチが条件で0行となった後の失敗理由(再読込した状態から) */
const failureAfter = async (
	db: DrizzleD1Database,
	latchId: string,
	now: Date,
): Promise<RespondResult> => {
	const [latch] = await db
		.select()
		.from(latches)
		.where(eq(latches.id, latchId));
	if (latch === undefined) return fail("not_found");
	return fail(closedReason(latch, now) ?? "invalid_status");
};

const isActive = (row: ResponseRow | undefined): row is ResponseRow =>
	row !== undefined && row.retractedAt === null;

/**
 * yes。1バッチで (1) 回答のupsert (2) 状態遷移の記録 (3) 状態の更新 (4) 機会の参加Intentのmatched化
 * の順に書き、(1)〜(3)は「LATCHが回答可能(proposed/partial_accept・期限内・参加Intentに
 * matchedが無い)」で条件付ける(F4a設計 §4.3)。参加Intentのmatched化を同じバッチで行うため、
 * 同じ機会Intentを含む別のLATCHが並行して成立することは無い(#23)
 */
const respondYes = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	now: Date,
): Promise<RespondResult> => {
	const nowMs = now.getTime();
	// つながりのIntentはmatchedにならないため、参加Intentの条件は機会にのみ効く
	const open = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status IN ('proposed', 'partial_accept') AND response_deadline > ${nowMs}
		AND NOT EXISTS (SELECT 1 FROM intents WHERE id IN (SELECT value FROM json_each(latches.intent_ids)) AND status = 'matched'))`;
	const member = sql`EXISTS (SELECT 1 FROM latch_members WHERE latch_id = ${latchId} AND user_id = ${userId})`;
	// このバッチで自分のyesが記録されたこと(既存の有効な回答は上書きしない)
	const recorded = sql`EXISTS (SELECT 1 FROM latch_responses WHERE latch_id = ${latchId} AND user_id = ${userId} AND response = 'yes' AND retracted_at IS NULL AND responded_at = ${nowMs})`;
	const yesCount = sql`(SELECT COUNT(*) FROM latch_responses WHERE latch_id = ${latchId} AND response = 'yes' AND retracted_at IS NULL)`;
	const memberCount = sql`(SELECT COUNT(*) FROM latch_members WHERE latch_id = ${latchId})`;
	const next = sql`CASE WHEN ${yesCount} = ${memberCount} THEN 'matched' ELSE 'partial_accept' END`;

	// retract後の再回答は同じ行をUPDATEして retracted_at を消す(F4a設計 §4.2)
	const upsert = db
		.insert(latchResponses)
		.select(
			sql`SELECT ${newUlid()}, ${latchId}, ${userId}, 'yes', NULL, ${nowMs}, NULL WHERE ${open} AND ${member}`,
		)
		.onConflictDoUpdate({
			target: [latchResponses.latchId, latchResponses.userId],
			set: {
				response: "yes",
				deferReason: null,
				respondedAt: now,
				retractedAt: null,
			},
			setWhere: isNotNull(latchResponses.retractedAt),
		});
	// 状態の更新より先に、更新前の状態を from として記録する(状態が変わらない場合は書かない)
	const insertEvent = db.insert(latchStatusEvents).select(
		sql`SELECT ${newUlid()}, id, status, ${next}, ${nowMs} FROM latches
				WHERE id = ${latchId} AND status != ${next} AND ${open} AND ${recorded}`,
	);
	const update = db
		.update(latches)
		.set({ status: sql`${next}`, updatedAt: now })
		.where(
			and(
				eq(latches.id, latchId),
				inArray(latches.status, [...OPEN_STATUSES]),
				sql`${latches.responseDeadline} > ${nowMs}`,
				open,
				recorded,
			),
		);
	// このバッチで成立した機会のLATCHに限り、参加Intentをmatchedにする(versionは上げない・
	// Layer 1がD1のstatusで除外する)。onMatched側の同じ更新は冪等な安全網として残す
	const matchIntents = db
		.update(intents)
		.set({ status: "matched", updatedAt: now })
		.where(
			and(
				sql`${intents.id} IN (SELECT value FROM json_each((SELECT intent_ids FROM latches WHERE id = ${latchId})))`,
				inArray(intents.status, ["active", "paused"]),
				sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND form = 'occasion' AND status = 'matched' AND updated_at = ${nowMs})`,
			),
		);
	await db.batch([upsert, insertEvent, update, matchIntents]);

	const mine = await responseOf(db, latchId, userId);
	if (
		!isActive(mine) ||
		mine.response !== "yes" ||
		mine.respondedAt.getTime() !== nowMs
	) {
		// 並行した同一ユーザーの回答が先に記録された場合
		if (isActive(mine)) return fail("already_responded");
		return failureAfter(db, latchId, now);
	}

	const [after] = await db
		.select({ status: latches.status })
		.from(latches)
		.where(eq(latches.id, latchId));
	// 並行したyesの双方がmatchedを読み得るため、onMatchedは冪等に作る
	if (after?.status === "matched") await onMatched(db, latchId, now);
	return { ok: true, latchId };
};

/** defer / no。先にLATCHを閉じ、閉じられたときだけ回答を記録する(閉じられなかった提案に回答行を残さない) */
const respondClose = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	response: "defer" | "no",
	now: Date,
): Promise<RespondResult> => {
	const closed = await closeLatch(
		db,
		latchId,
		"rejected",
		response === "defer" ? "deferred" : "rejected",
		[...OPEN_STATUSES],
		now,
	);
	if (!closed) return failureAfter(db, latchId, now);

	await db
		.insert(latchResponses)
		.values({
			id: newUlid(),
			latchId,
			userId,
			response,
			deferReason: null,
			respondedAt: now,
			retractedAt: null,
		})
		.onConflictDoUpdate({
			target: [latchResponses.latchId, latchResponses.userId],
			set: {
				response,
				deferReason: null,
				respondedAt: now,
				retractedAt: null,
			},
		});
	await releaseHeld(db, now, await membersOf(db, latchId));
	return { ok: true, latchId };
};

/** 提案への回答(F4a設計 §4.2)。判定順は 参加者確認 → 状態・期限 → 回答済み */
export const respond = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	response: LatchResponseValue,
	now: Date,
): Promise<RespondResult> => {
	const loaded = await loadForMember(db, latchId, userId);
	if (loaded === null) return fail("not_found");
	const reason = closedReason(loaded.latch, now);
	if (reason !== null) return fail(reason);
	if (isActive(loaded.mine)) return fail("already_responded");

	if (response === "yes") return respondYes(db, latchId, userId, now);
	return respondClose(db, latchId, userId, response, now);
};

/**
 * 自分のyesの取り消し(partial_accept・期限内のみ)。1バッチで回答の retracted_at・状態遷移の記録・
 * proposedへの更新を書く。相手のyesで既にmatchedならinvalid_status
 */
export const retract = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	now: Date,
): Promise<RespondResult> => {
	const loaded = await loadForMember(db, latchId, userId);
	if (loaded === null) return fail("not_found");
	if (loaded.latch.status !== "partial_accept") return fail("invalid_status");
	const reason = closedReason(loaded.latch, now);
	if (reason !== null) return fail(reason);
	const { mine } = loaded;
	if (!isActive(mine) || mine.response !== "yes") {
		return fail("invalid_status");
	}

	const nowMs = now.getTime();
	const partial = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status = 'partial_accept' AND response_deadline > ${nowMs})`;
	const retracted = sql`EXISTS (SELECT 1 FROM latch_responses WHERE latch_id = ${latchId} AND user_id = ${userId} AND retracted_at = ${nowMs})`;
	const noYes = sql`NOT EXISTS (SELECT 1 FROM latch_responses WHERE latch_id = ${latchId} AND response = 'yes' AND retracted_at IS NULL)`;
	await db.batch([
		db
			.update(latchResponses)
			.set({ retractedAt: now })
			.where(
				and(
					eq(latchResponses.latchId, latchId),
					eq(latchResponses.userId, userId),
					eq(latchResponses.response, "yes"),
					isNull(latchResponses.retractedAt),
					partial,
				),
			),
		db
			.insert(latchStatusEvents)
			.select(
				sql`SELECT ${newUlid()}, ${latchId}, 'partial_accept', 'proposed', ${nowMs} WHERE ${partial} AND ${retracted} AND ${noYes}`,
			),
		db
			.update(latches)
			.set({ status: "proposed", updatedAt: now })
			.where(
				and(
					eq(latches.id, latchId),
					eq(latches.status, "partial_accept"),
					retracted,
					noYes,
				),
			),
	]);

	const after = await responseOf(db, latchId, userId);
	if (after?.retractedAt?.getTime() === nowMs) return { ok: true, latchId };
	return failureAfter(db, latchId, now);
};

/** 成立後の参加取り消し(matchedのみ→cancelled・proposal_historyはmatchedのまま) */
export const leave = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	now: Date,
): Promise<RespondResult> => {
	const loaded = await loadForMember(db, latchId, userId);
	if (loaded === null) return fail("not_found");
	if (loaded.latch.status !== "matched") return fail("invalid_status");
	const closed = await closeLatch(
		db,
		latchId,
		"cancelled",
		null,
		["matched"],
		now,
	);
	return closed ? { ok: true, latchId } : fail("invalid_status");
};

/** 見送った本人が1回だけ見送り理由を保存する(F4a設計 §4.1) */
export const saveDeferReason = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	reason: DeferReason,
): Promise<RespondResult> => {
	const loaded = await loadForMember(db, latchId, userId);
	if (loaded === null) return fail("not_found");
	const { mine } = loaded;
	if (!isActive(mine) || mine.response !== "defer") {
		return fail("not_deferred");
	}
	if (mine.deferReason !== null) return fail("already_responded");
	const saved = await db
		.update(latchResponses)
		.set({ deferReason: reason })
		.where(
			and(
				eq(latchResponses.id, mine.id),
				eq(latchResponses.response, "defer"),
				isNull(latchResponses.deferReason),
			),
		)
		.returning({ id: latchResponses.id });
	return saved.length > 0 ? { ok: true, latchId } : fail("already_responded");
};

/**
 * 成立後処理(F4a設計 §4.4)。並行したyesの双方から呼ばれ得るため冪等に作る。
 * - proposal_historyをmatchedへ・参加者全員にmatched通知(重複は何もしない)
 * - 機会: 参加Intentをmatchedにし(versionは上げない・Layer 1がD1のstatusで除外する)、
 *   同じIntentを含む他のLATCH(candidate/proposed/partial_accept)をcancelledで閉じる(#23)
 * - 最後に関係ユーザー全員の保留を解放する(§3.5)
 */
const onMatched = async (
	db: DrizzleD1Database,
	latchId: string,
	now: Date,
): Promise<void> => {
	const [latch] = await db
		.select()
		.from(latches)
		.where(eq(latches.id, latchId));
	if (latch === undefined) return;
	const members = await membersOf(db, latchId);
	const nowMs = now.getTime();
	const matched = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latchId} AND status = 'matched')`;

	await db.batch([
		db
			.update(proposalHistory)
			.set({ outcome: "matched", updatedAt: now })
			.where(
				and(
					eq(proposalHistory.latchId, latchId),
					ne(proposalHistory.outcome, "matched"),
					matched,
				),
			),
		...members.map((userId) =>
			db
				.insert(notifications)
				.select(
					sql`SELECT ${newUlid()}, ${userId}, 'matched', ${latchId}, NULL, ${nowMs} WHERE ${matched}`,
				)
				.onConflictDoNothing(),
		),
	]);

	const related = new Set(members);
	if (latch.form === "occasion") {
		await db
			.update(intents)
			.set({ status: "matched", updatedAt: now })
			.where(
				and(
					inArray(intents.id, latch.intentIds),
					inArray(intents.status, ["active", "paused"]),
				),
			);
		const intentIdsJson = JSON.stringify(latch.intentIds);
		const others = await db
			.select({ id: latches.id })
			.from(latches)
			.where(
				and(
					ne(latches.id, latchId),
					inArray(latches.status, ["candidate", "proposed", "partial_accept"]),
					sql`EXISTS (SELECT 1 FROM json_each(${latches.intentIds}) WHERE value IN (SELECT value FROM json_each(${intentIdsJson})))`,
				),
			);
		for (const { id } of others) {
			for (const userId of await membersOf(db, id)) related.add(userId);
			await closeLatch(
				db,
				id,
				"cancelled",
				"expired",
				["candidate", "proposed", "partial_accept"],
				now,
			);
		}
	}
	await releaseHeld(db, now, [...related]);
};
