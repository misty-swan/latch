/**
 * Web Pushの送信の判断と未送信行の拾い上げ(F7b設計 §5.1・§5.2・§5.6)。
 * 時刻は引数で受け取る(docs/04 §4)。
 */

import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	intents,
	latches,
	notifications,
	pushSubscriptions,
} from "../db/schema";
import { createLogger } from "../logging/logger";
import { pushPayload, pushTtlSeconds } from "./payload";
import type { PushSender, PushSendResult } from "./sender";

const logger = createLogger();

/** 試行の最小間隔(F7b設計 §5.1 手順3・§5.6) */
const RETRY_INTERVAL_MS = 60_000;
/** この時間を過ぎたpendingは拾わない(§5.6) */
const MAX_AGE_MS = 10 * 60_000;
const FLUSH_LIMIT = 100;

type Db = DrizzleD1Database;
type FinalState = "sent" | "muted" | "no_subscription" | "failed";

/** 結果を1文の条件付きUPDATEで書く(pendingの間だけ) */
const settle = (db: Db, id: string, state: FinalState) =>
	db
		.update(notifications)
		.set({ pushState: state })
		.where(
			and(eq(notifications.id, id), eq(notifications.pushState, "pending")),
		);

const dispatchOne = async (
	db: Db,
	sender: PushSender,
	now: Date,
	id: string,
): Promise<void> => {
	// 順番を取る: 1行を更新できたときだけ送る(直後の送信とCronの回収が同時に拾っても片方だけ)
	const claimed = await db
		.update(notifications)
		.set({ pushAttemptedAt: now })
		.where(
			and(
				eq(notifications.id, id),
				eq(notifications.pushState, "pending"),
				or(
					isNull(notifications.pushAttemptedAt),
					lte(
						notifications.pushAttemptedAt,
						new Date(now.getTime() - RETRY_INTERVAL_MS),
					),
				),
			),
		)
		.returning({
			userId: notifications.userId,
			type: notifications.type,
			latchId: notifications.latchId,
		});
	const n = claimed[0];
	if (n === undefined) return;
	if (n.type !== "proposal" && n.type !== "matched") {
		await settle(db, id, "failed");
		return;
	}

	// 本人の当該LATCHでの参加Intentがmutedなら送らない
	let latch: { intentIds: string[]; responseDeadline: Date } | undefined;
	if (n.latchId !== null) {
		[latch] = await db
			.select({
				intentIds: latches.intentIds,
				responseDeadline: latches.responseDeadline,
			})
			.from(latches)
			.where(eq(latches.id, n.latchId));
	}
	if (latch !== undefined && latch.intentIds.length > 0) {
		const mine = await db
			.select({ level: intents.notificationLevel })
			.from(intents)
			.where(
				and(inArray(intents.id, latch.intentIds), eq(intents.userId, n.userId)),
			);
		if (mine.some((r) => r.level === "muted")) {
			await settle(db, id, "muted");
			return;
		}
	}

	const subs = await db
		.select()
		.from(pushSubscriptions)
		.where(
			and(
				eq(pushSubscriptions.userId, n.userId),
				eq(pushSubscriptions.status, "active"),
			),
		);
	if (subs.length === 0) {
		await settle(db, id, "no_subscription");
		return;
	}

	const payload = pushPayload(n.type);
	const ttl = pushTtlSeconds(
		n.type,
		now,
		n.type === "proposal" ? (latch?.responseDeadline ?? null) : null,
	);
	let anyOk = false;
	let anyRetry = false;
	let lastStatus: number | null = null;
	let lastKind: PushSendResult["kind"] = "rejected";
	for (const sub of subs) {
		const r = await sender.send(
			{ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
			payload,
			{ ttl, urgency: "high" },
		);
		lastKind = r.kind;
		if (r.kind === "ok") {
			anyOk = true;
			await db
				.update(pushSubscriptions)
				.set({ lastSuccessAt: now })
				.where(eq(pushSubscriptions.id, sub.id));
		} else if (r.kind === "gone") {
			// 購読の失効: 以後送らない
			await db
				.update(pushSubscriptions)
				.set({ status: "failed" })
				.where(eq(pushSubscriptions.id, sub.id));
		} else if (r.kind === "retry") {
			anyRetry = true;
			lastStatus = r.status;
		} else {
			lastStatus = r.status;
		}
	}

	if (anyOk) {
		await settle(db, id, "sent");
		logger.info("push.sent", { notification_id: id, push_result: "sent" });
	} else if (anyRetry) {
		// 一時失敗: pendingのまま(60秒後以降にCronの回収が再試行する)
		logger.warn("push.failed", {
			notification_id: id,
			push_result: "retry",
			...(lastStatus !== null ? { http_status: lastStatus } : {}),
		});
	} else {
		await settle(db, id, "failed");
		logger.warn("push.failed", {
			notification_id: id,
			push_result: lastKind,
			...(lastStatus !== null ? { http_status: lastStatus } : {}),
		});
	}
};

/** 通知行ごとに順番を取り、判断(muted・購読なし・送信)して結果を書く(F7b設計 §5.1) */
export async function dispatchPush(
	db: Db,
	sender: PushSender,
	now: Date,
	ids: string[],
): Promise<void> {
	for (const id of ids) {
		try {
			await dispatchOne(db, sender, now, id);
		} catch (e) {
			// 1行の失敗で他の行を止めない。pendingのまま回収に任せる
			logger.error("push.failed", {
				notification_id: id,
				push_result: "error",
				error_code: e instanceof Error ? e.name : "unknown",
			});
		}
	}
}

/**
 * 未送信のpendingを拾ってdispatchPushへ渡す(F7b設計 §5.1 手順2・§5.6)。
 * 対象=作成からminAgeMs以上かつ10分以内・未試行または試行から60秒以上・id昇順100件。
 * 戻り値は渡した件数
 */
export async function flushPush(
	db: Db,
	sender: PushSender,
	now: Date,
	opts: { minAgeMs: number },
): Promise<number> {
	const rows = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(
			and(
				eq(notifications.pushState, "pending"),
				lte(notifications.createdAt, new Date(now.getTime() - opts.minAgeMs)),
				gte(notifications.createdAt, new Date(now.getTime() - MAX_AGE_MS)),
				or(
					isNull(notifications.pushAttemptedAt),
					lte(
						notifications.pushAttemptedAt,
						new Date(now.getTime() - RETRY_INTERVAL_MS),
					),
				),
			),
		)
		.orderBy(asc(notifications.id))
		.limit(FLUSH_LIMIT);
	const ids = rows.map((r) => r.id);
	if (ids.length > 0) await dispatchPush(db, sender, now, ids);
	return ids.length;
}
