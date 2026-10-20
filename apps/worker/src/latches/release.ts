/**
 * 保留(candidate)の解放と期限切れ(F4a設計 §3.5・docs/06 §2の(i))。
 * 呼び出し元は提案のクローズ時(関係ユーザー対象)と毎分Cron(全体対象)。
 */

import { LATCH, PIPELINE } from "@latch/shared";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	intents,
	latches,
	latchMembers,
	latchStatusEvents,
	notifications,
} from "../db/schema";
import { newUlid } from "../ids";
import type { IntentRow } from "../pipeline/consumer";
import { canPresent } from "./caps";
import { closeLatch } from "./close";
import {
	isTooLate,
	minExpiry,
	occasionTargetAt,
	responseDeadline,
} from "./deadline";

type LatchRow = typeof latches.$inferSelect;

/** 機会の対象時刻(proposal.time_window.start・ISO 8601は文字列順=時刻順) */
const targetStart = sql`json_extract(${latches.proposal}, '$.time_window.start')`;

/** 参加Intentを intent_ids の順で読む。1件でも不在ならnull */
const intentsOf = async (
	db: DrizzleD1Database,
	latch: LatchRow,
): Promise<IntentRow[] | null> => {
	const rows = await db
		.select()
		.from(intents)
		.where(inArray(intents.id, latch.intentIds));
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ordered = latch.intentIds.map((id) => byId.get(id));
	return ordered.every((r) => r !== undefined) ? ordered : null;
};

/**
 * 保留中に参加Intentの期限(latches.expires_at)を過ぎたもの・機会で対象時刻まで75分未満と
 * なったものを、提示せず expired で閉じる(通知なし・proposal_historyはexpired)。戻り値は閉じた件数
 */
export const expireHeld = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<number> => {
	let closed = 0;
	const overdue = await db
		.select({ id: latches.id })
		.from(latches)
		.where(and(eq(latches.status, "candidate"), lte(latches.expiresAt, now)))
		.orderBy(asc(latches.expiresAt), asc(latches.id))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const { id } of overdue) {
		if (await closeLatch(db, id, "expired", "expired", ["candidate"], now)) {
			closed++;
		}
	}

	// 機会は対象時刻(proposal.time_window.start=occasionTargetAtと同じ値)が now+75分 より前のものに
	// SQLで先に絞る(参加Intentの読み出しを該当候補に限るための最適化)。判定の正は下のisTooLate
	const leadLimit = new Date(
		now.getTime() + LATCH.OCCASION_MIN_LEAD_MS,
	).toISOString();
	const occasions = await db
		.select()
		.from(latches)
		.where(
			and(
				eq(latches.status, "candidate"),
				eq(latches.form, "occasion"),
				lt(targetStart, leadLimit),
			),
		)
		.orderBy(asc(targetStart), asc(latches.id))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const latch of occasions) {
		const pair = await intentsOf(db, latch);
		// 参加Intentが不在のものは releaseHeld が cancelled で閉じる
		if (pair === null) continue;
		const [a, b] = pair;
		if (a === undefined || b === undefined) continue;
		if (a.startsAt === null || b.startsAt === null) continue;
		if (!isTooLate(occasionTargetAt(a, b), now)) continue;
		if (
			await closeLatch(db, latch.id, "expired", "expired", ["candidate"], now)
		) {
			closed++;
		}
	}
	return closed;
};

/** candidate → proposed の昇格を1バッチで書く。昇格できたらtrue */
const promote = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	userIds: string[],
	deadline: Date,
	now: Date,
): Promise<boolean> => {
	const nowMs = now.getTime();
	const promoted = sql`EXISTS (SELECT 1 FROM latches WHERE id = ${latch.id} AND status = 'proposed' AND proposed_at = ${nowMs} AND updated_at = ${nowMs})`;
	await db.batch([
		db
			.update(latches)
			.set({
				status: "proposed",
				proposedAt: now,
				responseDeadline: deadline,
				updatedAt: now,
			})
			.where(and(eq(latches.id, latch.id), eq(latches.status, "candidate"))),
		db
			.insert(latchStatusEvents)
			.select(
				sql`SELECT ${newUlid()}, ${latch.id}, 'candidate', 'proposed', ${nowMs} WHERE ${promoted}`,
			),
		...userIds.map((userId) =>
			db
				.insert(notifications)
				.select(
					sql`SELECT ${newUlid()}, ${userId}, 'proposal', ${latch.id}, NULL, ${nowMs} WHERE ${promoted}`,
				)
				.onConflictDoNothing(),
		),
	]);
	const [after] = await db
		.select({ status: latches.status, proposedAt: latches.proposedAt })
		.from(latches)
		.where(eq(latches.id, latch.id));
	return after?.status === "proposed" && after.proposedAt?.getTime() === nowMs;
};

/**
 * 保留(candidate)を順に走査し、提示の上限(F4a設計 §3.3)を満たすものを proposed へ昇格する。
 * 順序: 機会=対象時刻の近い順 → つながり=score降順(同点はid昇順)。1回の走査は最大500件。
 * 参加Intentが matched・expired・cancelled・不在なら cancelled で閉じ(排他の取りこぼしの安全網)、
 * paused なら保留のまま残す(pauseは提案を継続する・docs/06 §2)。
 * userIds 指定時はその参加者の保留のみを対象とする。戻り値は昇格した件数
 */
export const releaseHeld = async (
	db: DrizzleD1Database,
	now: Date,
	userIds?: string[],
): Promise<number> => {
	await expireHeld(db, now);
	if (userIds !== undefined && userIds.length === 0) return 0;

	const scope =
		userIds === undefined
			? undefined
			: inArray(
					latches.id,
					db
						.select({ id: latchMembers.latchId })
						.from(latchMembers)
						.where(inArray(latchMembers.userId, userIds)),
				);
	const limit = PIPELINE.CRON_BATCH_LIMIT;
	const occasions = await db
		.select()
		.from(latches)
		.where(
			and(eq(latches.status, "candidate"), eq(latches.form, "occasion"), scope),
		)
		.orderBy(asc(targetStart), asc(latches.id))
		.limit(limit);
	const connections =
		occasions.length < limit
			? await db
					.select()
					.from(latches)
					.where(
						and(
							eq(latches.status, "candidate"),
							eq(latches.form, "connection"),
							scope,
						),
					)
					.orderBy(desc(latches.score), asc(latches.id))
					.limit(limit - occasions.length)
			: [];

	let released = 0;
	for (const latch of [...occasions, ...connections]) {
		const pair = await intentsOf(db, latch);
		const [a, b] = pair ?? [];
		if (
			pair === null ||
			a === undefined ||
			b === undefined ||
			pair.some(
				(i) =>
					i.status === "matched" ||
					i.status === "expired" ||
					i.status === "cancelled",
			)
		) {
			await closeLatch(
				db,
				latch.id,
				"cancelled",
				"expired",
				["candidate"],
				now,
			);
			continue;
		}
		// paused(と想定外の状態)は保留のまま残す
		if (pair.some((i) => i.status !== "active")) continue;

		const members = await db
			.select({ userId: latchMembers.userId })
			.from(latchMembers)
			.where(eq(latchMembers.latchId, latch.id));
		const memberIds = members.map((m) => m.userId);
		if (!(await canPresent(db, memberIds, latch.intentIds, now))) continue;

		const targetAt = latch.form === "occasion" ? occasionTargetAt(a, b) : null;
		const deadline = responseDeadline(
			latch.form,
			now,
			targetAt,
			minExpiry(a, b),
		);
		if (await promote(db, latch, memberIds, deadline, now)) released++;
	}
	return released;
};
