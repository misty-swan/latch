/**
 * Web Pushの送信の判断と未送信行の拾い上げ(F7b設計 §5.1・§5.2・§5.6)。
 * 時刻はClockで受け取る(docs/04 §4)。順番取りは1文の条件付きUPDATEで、全行を開始時刻で取る。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
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
/**
 * 1回のflushPushが行を判断してよい時間。順番は開始時刻で全行まとめて取るため、
 * 期限を過ぎたら残りは判断せず、順番を取ったままpendingに残す。取りから60秒で他の送出が
 * 同じ行を取り直せるので、1回の送出を60秒より十分短く収める(残りは後の送出・Cronの回収が拾う)
 */
const FLUSH_BUDGET_MS = 45_000;

type Db = DrizzleD1Database;
type FinalState = "sent" | "muted" | "no_subscription" | "failed";

/**
 * 結果を1文の条件付きUPDATEで書く。pendingで、かつ順番取りの時刻がこの試行のもののときだけ
 * (遅れて戻った先行の試行が、順番を取り直した後続の試行の結果を上書きしない)
 */
const settle = (db: Db, id: string, state: FinalState, claimedAt: Date) =>
	db
		.update(notifications)
		.set({ pushState: state })
		.where(
			and(
				eq(notifications.id, id),
				eq(notifications.pushState, "pending"),
				eq(notifications.pushAttemptedAt, claimedAt),
			),
		);

type ClaimedRow = {
	userId: string;
	type: string;
	latchId: string | null;
};

/** 順番を取れた1行を判断(muted・購読なし・送信)して結果を書く */
const judgeClaimed = async (
	db: Db,
	sender: PushSender,
	clock: Clock,
	id: string,
	n: ClaimedRow,
	claimedAt: Date,
): Promise<void> => {
	if (n.type !== "proposal" && n.type !== "matched") {
		await settle(db, id, "failed", claimedAt);
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
			await settle(db, id, "muted", claimedAt);
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
		await settle(db, id, "no_subscription", claimedAt);
		return;
	}

	const payload = pushPayload(n.type);
	const ttl = pushTtlSeconds(
		n.type,
		claimedAt,
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
				.set({ lastSuccessAt: clock.now() })
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
		await settle(db, id, "sent", claimedAt);
		logger.info("push.sent", { notification_id: id, push_result: "sent" });
	} else if (anyRetry) {
		// 一時失敗: pendingのまま(60秒後以降にCronの回収が再試行する)
		logger.warn("push.failed", {
			notification_id: id,
			push_result: "retry",
			...(lastStatus !== null ? { http_status: lastStatus } : {}),
		});
	} else {
		await settle(db, id, "failed", claimedAt);
		logger.warn("push.failed", {
			notification_id: id,
			push_result: lastKind,
			...(lastStatus !== null ? { http_status: lastStatus } : {}),
		});
	}
};

/**
 * 未送信のpendingの対象選びと順番取りを1文の条件付きUPDATEで行い(#39・D1への問い合わせを減らす)、
 * 取れた行だけを1件ずつ判断して結果を書く(F7b設計 §5.1 手順2・§5.6)。
 * 対象=作成からminAgeMs以上かつ10分以内・未試行または試行から60秒以上・id昇順100件。
 * createdFromがあればその時刻以降に作られた行だけを対象にする。
 * 順番取りの時刻は全行で同じ(開始時刻)。開始から45秒を過ぎたら残りの行は判断せず、
 * 順番を取ったままpendingに残す(60秒後以降の送出・Cronの回収が取り直す)。
 * 戻り値は順番を取れた件数
 */
export async function flushPush(
	db: Db,
	sender: PushSender,
	clock: Clock,
	opts: { minAgeMs: number; createdFrom?: Date },
): Promise<number> {
	const now = clock.now();
	const nowMs = now.getTime();
	const retryBefore = nowMs - RETRY_INTERVAL_MS;
	const from =
		opts.createdFrom !== undefined
			? sql`AND created_at >= ${opts.createdFrom.getTime()}`
			: sql``;
	const rows = await db.all<{
		id: string;
		user_id: string;
		type: string;
		latch_id: string | null;
	}>(sql`
		UPDATE notifications SET push_attempted_at = ${nowMs}
		WHERE id IN (
			SELECT id FROM notifications
			WHERE push_state = 'pending'
				AND created_at <= ${nowMs - opts.minAgeMs}
				AND created_at >= ${nowMs - MAX_AGE_MS}
				${from}
				AND (push_attempted_at IS NULL OR push_attempted_at <= ${retryBefore})
			ORDER BY id ASC
			LIMIT ${FLUSH_LIMIT}
		)
		AND push_state = 'pending'
		AND (push_attempted_at IS NULL OR push_attempted_at <= ${retryBefore})
		RETURNING id, user_id, type, latch_id
	`);
	rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const deadlineMs = nowMs + FLUSH_BUDGET_MS;
	for (const r of rows) {
		if (clock.now().getTime() >= deadlineMs) break;
		try {
			await judgeClaimed(
				db,
				sender,
				clock,
				r.id,
				{ userId: r.user_id, type: r.type, latchId: r.latch_id },
				now,
			);
		} catch (e) {
			// 1行の失敗で他の行を止めない。pendingのまま回収に任せる
			logger.error("push.failed", {
				notification_id: r.id,
				push_result: "error",
				error_code: e instanceof Error ? e.name : "unknown",
			});
		}
	}
	return rows.length;
}
