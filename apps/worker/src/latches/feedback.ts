/**
 * 正解データの自己申告(docs/01 §14・docs/05 §3.3・F9)。
 * - 種別は形式で決まる: 機会=attendance・つながり=connection_quality(違えばkind_mismatch)
 * - 受付: attendanceは機会LATCHがcompletedになった後、connection_qualityは成立から7日以後
 *   (matched・completed・matched経由のcancelled)。締め切りは設けない(2026-10-26オーナー裁定)
 * - 1人1種別1回(UNIQUE(latch_id, user_id, kind))。2回目はalready_responded。
 *   値のnullはスキップで、答えなかったことを1回分として記録する(同じ裁定)
 */

import {
	type IntentForm,
	LATCH,
	type LatchFeedbackKind,
	type LatchFeedbackRequest,
} from "@latch/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { type latches, latchFeedback, latchStatusEvents } from "../db/schema";
import { newUlid } from "../ids";
import { loadForMember, type RespondResult } from "./respond";

type LatchRow = typeof latches.$inferSelect;

/** 形式ごとにたずねる種別 */
export const feedbackKindOf = (form: IntentForm): LatchFeedbackKind =>
	form === "occasion" ? "attendance" : "connection_quality";

/** 受付中か。matchedAtは成立の状態記録(to_status=matched)の時刻 */
export const isFeedbackOpen = (
	latch: LatchRow,
	matchedAt: Date | null,
	now: Date,
): boolean => {
	if (latch.form === "occasion") return latch.status === "completed";
	return (
		matchedAt !== null &&
		now.getTime() >= matchedAt.getTime() + LATCH.CONNECTION_FEEDBACK_AFTER_MS
	);
};

const matchedAtOf = async (
	db: DrizzleD1Database,
	latchId: string,
): Promise<Date | null> => {
	const [ev] = await db
		.select({ createdAt: latchStatusEvents.createdAt })
		.from(latchStatusEvents)
		.where(
			and(
				eq(latchStatusEvents.latchId, latchId),
				eq(latchStatusEvents.toStatus, "matched"),
			),
		)
		.limit(1);
	return ev?.createdAt ?? null;
};

/** 本人に今たずねる種別。受付中で未申告ならその種別・それ以外はnull(LatchDTO.feedback_due) */
export const feedbackDue = async (
	db: DrizzleD1Database,
	latch: LatchRow,
	matchedAt: Date | null,
	userId: string,
	now: Date,
): Promise<LatchFeedbackKind | null> => {
	if (!isFeedbackOpen(latch, matchedAt, now)) return null;
	const kind = feedbackKindOf(latch.form);
	const [row] = await db
		.select({ id: latchFeedback.id })
		.from(latchFeedback)
		.where(
			and(
				eq(latchFeedback.latchId, latch.id),
				eq(latchFeedback.userId, userId),
				eq(latchFeedback.kind, kind),
			),
		)
		.limit(1);
	return row === undefined ? kind : null;
};

/**
 * 申告を保存する。参加しない・存在しない・保留中・離脱済み・表示から消したものはnot_found。
 * 重複の判定はUNIQUEに任せる(並行した2回でも1行だけが残る)
 */
export const submitFeedback = async (
	db: DrizzleD1Database,
	latchId: string,
	userId: string,
	request: LatchFeedbackRequest,
	now: Date,
): Promise<RespondResult> => {
	const loaded = await loadForMember(db, latchId, userId);
	if (loaded === null) return { ok: false, reason: "not_found" };
	const { latch } = loaded;
	if (request.kind !== feedbackKindOf(latch.form)) {
		return { ok: false, reason: "kind_mismatch" };
	}
	if (!isFeedbackOpen(latch, await matchedAtOf(db, latchId), now)) {
		return { ok: false, reason: "invalid_status" };
	}
	const saved = await db
		.insert(latchFeedback)
		.values({
			id: newUlid(),
			latchId,
			userId,
			kind: request.kind,
			value: request.value,
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: latchFeedback.id });
	return saved.length > 0
		? { ok: true, latchId }
		: { ok: false, reason: "already_responded" };
};
