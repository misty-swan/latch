/**
 * 通報(F7a設計 §0.3の4・§3)。
 * - target=proposal: 提案中(proposed・partial_accept)のLATCHの参加者が、自分以外の全参加者を通報する
 *   (被通報者は本文で指定しない)。提案は提示後に限る(candidateは参加者に見えない)
 * - 成立後(profile・icon・message): left_atのない参加者が、自分以外のメンバー1人を通報する。
 *   対象のLATCHはmatched・completed・matched経由のcancelled。messageは被通報者の発言であること
 * - 同じ通報の再送は統合する(open行があればreason・note・created_atを上書き)。resolved後は新しい行
 * - 通報は被通報者の画面・LATCHの状態に影響しない。noteと被通報者はログに出さない(docs/08 §6)
 * 失敗の写像: 対象外・存在しない=not_found(一律404)/ 形の誤り=invalid(400・理由コード)
 */

import type { ReportCreateRequest } from "@latch/shared";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { latches, latchMembers, messages, reports } from "../db/schema";
import { wasMatched } from "../latches/hide";

export type ReportOutcome =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "invalid"; reasons: string[] };

/** 形の検証(F7a設計 §3.2)。理由コードを全て集めて返す */
const shapeReasons = (input: ReportCreateRequest): string[] => {
	const reasons: string[] = [];
	if (input.target === "proposal") {
		if (input.reportee_user_id !== undefined) {
			reasons.push("reportee_not_allowed");
		}
		if (input.message_id !== undefined) reasons.push("message_not_allowed");
		return reasons;
	}
	if (input.reportee_user_id === undefined) reasons.push("reportee_required");
	if (input.target === "message") {
		if (input.message_id === undefined) reasons.push("message_required");
	} else if (input.message_id !== undefined) {
		reasons.push("message_not_allowed");
	}
	return reasons;
};

/** 同じ通報のopen行があれば上書き、無ければ挿入する(統合・F7a設計 §3.2) */
const upsertReport = async (
	db: DrizzleD1Database,
	row: {
		reporter: string;
		reportee: string;
		latchId: string;
		target: ReportCreateRequest["target"];
		messageId: string | null;
		reason: ReportCreateRequest["reason"];
		note: string;
		now: Date;
	},
): Promise<void> => {
	const [open] = await db
		.select({ id: reports.id })
		.from(reports)
		.where(
			and(
				eq(reports.reporter, row.reporter),
				eq(reports.latchId, row.latchId),
				eq(reports.reportee, row.reportee),
				eq(reports.target, row.target),
				row.messageId === null
					? isNull(reports.messageId)
					: eq(reports.messageId, row.messageId),
				eq(reports.status, "open"),
			),
		)
		.limit(1);
	if (open !== undefined) {
		await db
			.update(reports)
			.set({ reason: row.reason, note: row.note, createdAt: row.now })
			.where(eq(reports.id, open.id));
		return;
	}
	await db.insert(reports).values({
		id: ulid(),
		reporter: row.reporter,
		reportee: row.reportee,
		reason: row.reason,
		target: row.target,
		latchId: row.latchId,
		messageId: row.messageId,
		note: row.note,
		status: "open",
		createdAt: row.now,
	});
};

export const createReport = async (
	db: DrizzleD1Database,
	reporterId: string,
	input: ReportCreateRequest,
	now: Date,
): Promise<ReportOutcome> => {
	const reasons = shapeReasons(input);
	if (reasons.length > 0) return { ok: false, reason: "invalid", reasons };

	const [latch] = await db
		.select({ status: latches.status })
		.from(latches)
		.innerJoin(
			latchMembers,
			and(
				eq(latchMembers.latchId, latches.id),
				eq(latchMembers.userId, reporterId),
			),
		)
		.where(eq(latches.id, input.latch_id))
		.limit(1);
	if (latch === undefined) return { ok: false, reason: "not_found" };
	const note = input.note ?? "";
	const base = {
		reporter: reporterId,
		latchId: input.latch_id,
		target: input.target,
		reason: input.reason,
		note,
		now,
	};

	if (input.target === "proposal") {
		if (latch.status !== "proposed" && latch.status !== "partial_accept") {
			return { ok: false, reason: "not_found" };
		}
		const others = await db
			.select({ userId: latchMembers.userId })
			.from(latchMembers)
			.where(
				and(
					eq(latchMembers.latchId, input.latch_id),
					ne(latchMembers.userId, reporterId),
				),
			);
		for (const o of others) {
			await upsertReport(db, { ...base, reportee: o.userId, messageId: null });
		}
		return { ok: true };
	}

	// 成立後: 本人はleft_atなしの参加者、LATCHは成立後の状態
	const [self] = await db
		.select({ leftAt: latchMembers.leftAt })
		.from(latchMembers)
		.where(
			and(
				eq(latchMembers.latchId, input.latch_id),
				eq(latchMembers.userId, reporterId),
			),
		)
		.limit(1);
	if (self === undefined || self.leftAt !== null) {
		return { ok: false, reason: "not_found" };
	}
	const afterMatch =
		latch.status === "matched" ||
		latch.status === "completed" ||
		(latch.status === "cancelled" && (await wasMatched(db, input.latch_id)));
	const reportee = input.reportee_user_id;
	if (!afterMatch || reportee === undefined || reportee === reporterId) {
		return { ok: false, reason: "not_found" };
	}
	const [member] = await db
		.select({ userId: latchMembers.userId })
		.from(latchMembers)
		.where(
			and(
				eq(latchMembers.latchId, input.latch_id),
				eq(latchMembers.userId, reportee),
			),
		)
		.limit(1);
	if (member === undefined) return { ok: false, reason: "not_found" };

	let messageId: string | null = null;
	if (input.target === "message" && input.message_id !== undefined) {
		const [msg] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.id, input.message_id),
					eq(messages.latchId, input.latch_id),
					eq(messages.userId, reportee),
				),
			)
			.limit(1);
		if (msg === undefined) return { ok: false, reason: "not_found" };
		messageId = msg.id;
	}
	await upsertReport(db, { ...base, reportee, messageId });
	return { ok: true };
};
