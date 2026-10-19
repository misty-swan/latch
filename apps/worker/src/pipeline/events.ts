/**
 * match_events行のINSERTとMATCH_QUEUEへの投入(docs/06 §2)。
 * 作成とdraft→active化は即時投入・更新のみ10秒の遅延配信(delaySeconds)を
 * 呼び出し側が指定する。sendはINSERT完了の後に行う(消費側がevent_idで
 * D1行を読める順序を保証する)。UNIQUE(event_type, source_intent_id, version)の
 * 衝突は同一イベントの再発行と見なして既存行のidでsendだけを行う(冪等)。
 */
import type { MatchEventType } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { systemClock } from "../clock/clock";
import { matchEvents } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";

/** emitMatchEventのパラメータ */
export interface EmitMatchEventParams {
	/** イベント種別(第1段の作成・更新と、第1段からの再投入embedding_completed・docs/06 §2) */
	eventType: Extract<
		MatchEventType,
		"intent_created" | "intent_updated" | "embedding_completed"
	>;
	/** 起点Intentのid */
	intentId: string;
	/** Intentのversion(発行時点の値・更新後イベントは更新後のversion) */
	version: number;
}

/** emitMatchEventのオプション */
export interface EmitMatchEventOptions {
	/** Queuesの遅延配信(秒)。未指定は即時(docs/06 §2: 更新のみ10秒) */
	delaySeconds?: number;
}

/**
 * D1のUNIQUE制約違反かどうか。drizzleはクエリ失敗をDrizzleQueryErrorでラップし
 * 元のD1エラーをcauseに入れるため、cause連鎖を辿って判定する。
 * 衝突だけを特別扱いし、他の失敗は握り潰さない
 */
const isUniqueViolation = (error: unknown): boolean => {
	let current: unknown = error;
	while (current instanceof Error) {
		if (current.message.includes("UNIQUE constraint failed")) {
			return true;
		}
		current = current.cause;
	}
	return false;
};

/**
 * MATCH_QUEUEへ送信する。delaySeconds未指定は第2引数なしの即時送信
 * (docs/06 §2: 作成とdraft→active化は即時投入)。戻り値は送信したイベントのid
 */
const sendToMatchQueue = async (
	env: Env,
	eventId: string,
	opts?: EmitMatchEventOptions,
): Promise<string> => {
	const delaySeconds = opts?.delaySeconds;
	if (delaySeconds === undefined) {
		await env.MATCH_QUEUE.send({ event_id: eventId });
	} else {
		await env.MATCH_QUEUE.send({ event_id: eventId }, { delaySeconds });
	}
	return eventId;
};

/**
 * match_events行をINSERT(status=pending・payload={})してMATCH_QUEUEへ送る。
 * 戻り値はイベントのid。INSERTはawaitして完了を待ってからsendする。
 * UNIQUE衝突時は既存同一イベントの再発行として、既存行のidでsendだけを行う(冪等)。
 * ルートからはc.executionCtx.waitUntil(...)経由で呼び、応答をブロックしない
 * (docs/04 §7の保存p95)
 */
export const emitMatchEvent = async (
	env: Env,
	params: EmitMatchEventParams,
	opts?: EmitMatchEventOptions,
): Promise<string> => {
	const db = drizzle(env.DB);
	const eventId = newUlid();
	try {
		await db.insert(matchEvents).values({
			id: eventId,
			eventType: params.eventType,
			sourceIntentId: params.intentId,
			version: params.version,
			payload: {},
			status: "pending",
			createdAt: systemClock.now(),
		});
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		// 衝突=既存同一イベントが存在する。既存行のidを取得してsendだけ行う。
		// 取得できない場合は衝突扱いにできず、握り潰さず再スローする
		const [existing] = await db
			.select({ id: matchEvents.id })
			.from(matchEvents)
			.where(
				and(
					eq(matchEvents.eventType, params.eventType),
					eq(matchEvents.sourceIntentId, params.intentId),
					eq(matchEvents.version, params.version),
				),
			)
			.limit(1);
		if (existing === undefined) {
			throw error;
		}
		return await sendToMatchQueue(env, existing.id, opts);
	}
	return await sendToMatchQueue(env, eventId, opts);
};
