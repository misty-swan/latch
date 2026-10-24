/**
 * match_events行のINSERTとMATCH_QUEUEへの投入(docs/06 §2)。
 * 作成とdraft→active化は即時投入・更新のみ10秒の遅延配信(delaySeconds)を
 * 呼び出し側が指定する。sendはINSERT完了の後に行う(消費側がevent_idで
 * D1行を読める順序を保証する)。UNIQUE(event_type, source_intent_id, version)の
 * 衝突は同一イベントの再発行と見なして既存行のidでsendだけを行う(冪等)。
 */
import type { MatchEventType, MatchQueueMessage } from "@latch/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { matchEvents } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";

/** emitMatchEventのパラメータ */
export interface EmitMatchEventParams {
	/** イベント種別(第1段の作成・更新と、第1段からの再投入embedding_completed・反映確認vector_reflection・docs/06 §2) */
	eventType: Extract<
		MatchEventType,
		| "intent_created"
		| "intent_updated"
		| "embedding_completed"
		| "vector_reflection"
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
	/** 第1段が計算したベクトル(embedding_completedのメッセージへ載せる) */
	vector?: number[];
	/**
	 * trueなら、新しく作った行の送信が失敗したときにその行を消してから例外を返す。
	 * 第1段の投入のやり直しは「行がある=送れた」として送れていない分だけを投入するため、
	 * 送れなかった行を残さない(消すのに失敗したら行は残り、pending残留の掃査がfailedにする)
	 */
	discardOnSendFailure?: boolean;
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
export const sendToMatchQueue = async (
	env: Env,
	eventId: string,
	opts?: EmitMatchEventOptions,
): Promise<string> => {
	const delaySeconds = opts?.delaySeconds;
	const body: MatchQueueMessage =
		opts?.vector === undefined
			? { event_id: eventId }
			: { event_id: eventId, vector: opts.vector };
	if (delaySeconds === undefined) {
		await env.MATCH_QUEUE.send(body);
	} else {
		await env.MATCH_QUEUE.send(body, { delaySeconds });
	}
	return eventId;
};

/**
 * match_events行をINSERT(status=pending・payload={})する。UNIQUE衝突は既存同一イベントと
 * 見なして既存行のidを返す(created=false)。取得できなければ衝突扱いにできず再スローする
 */
const insertMatchEvent = async (
	env: Env,
	params: EmitMatchEventParams,
	clock: Clock,
): Promise<{ id: string; created: boolean }> => {
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
			createdAt: clock.now(),
		});
		return { id: eventId, created: true };
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
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
		return { id: existing.id, created: false };
	}
};

/**
 * match_events行をINSERT(status=pending・payload={})だけ行い、キューへは送らない。
 * 戻り値はイベントのid(UNIQUE衝突なら既存行のid)。第1段の後に同じ実行で第2段を続ける
 * 経路が、embedding_completedの行を処理中に作るのに使う(#30・不具合の修正工程(第3回)の設計 §3)
 */
export const recordMatchEvent = async (
	env: Env,
	params: EmitMatchEventParams,
	clock: Clock,
): Promise<string> => (await insertMatchEvent(env, params, clock)).id;

/**
 * match_events行をINSERT(status=pending・payload={})してMATCH_QUEUEへ送る。
 * 戻り値はイベントのid。INSERTはawaitして完了を待ってからsendする。
 * UNIQUE衝突時は既存同一イベントの再発行として、既存行のidでsendだけを行う(冪等)。
 * 時刻はClock注入(docs/04 §4): ルートはsystemClock・pipelineは注入Clockを渡す。
 * ルートからはc.executionCtx.waitUntil(...)経由で呼び、応答をブロックしない
 * (docs/04 §7の保存p95)
 */
export const emitMatchEvent = async (
	env: Env,
	params: EmitMatchEventParams,
	opts: EmitMatchEventOptions | undefined,
	clock: Clock,
): Promise<string> => {
	const { id, created } = await insertMatchEvent(env, params, clock);
	try {
		return await sendToMatchQueue(env, id, opts);
	} catch (error) {
		// 新しく作った行だけを消す(衝突で見つけた既存行は消さない)
		if (created && opts?.discardOnSendFailure === true) {
			try {
				await drizzle(env.DB).delete(matchEvents).where(eq(matchEvents.id, id));
			} catch {
				// 消せなければ行は残る(送信の失敗のほうを呼び出し側へ返す)
			}
		}
		throw error;
	}
};
