/**
 * 反映確認のイベント(vector_reflection)の消費と遅延の計算(不具合の修正工程の設計 §2.3)。
 * 第1段はVectorStoreへのupsertの反映を待たずに第2段へ進むため、同時に預けた相手の
 * ベクトルが第2段の時点でまだ見えないことがある(#7)。第1段は同versionの
 * vector_reflectionを遅延付きで投入し、ここで自分のベクトルの反映(metadataのversionの
 * 一致)を確かめてから、30分の再評価抑制の例外として1回だけ評価し直す。
 * 未反映なら同じイベントidを遅延付きで送り直し、作成から8分で打ち切ってfailedへ倒す
 * (以後はCronの(h)が拾う)。確認の途中の例外は次のとおり扱う(#23):
 * getByIdsの例外は未反映と同じに送り直し、送り直しの送信の例外は受け取ったメッセージの
 * retryでやり直す(max_retriesを超えたものはDLQでdeadになる)。1回きりの保証はmatch_eventsのUNIQUEと処理済みの
 * 再消費スキップによる(docs/06 §2)。
 */
import { PIPELINE } from "@latch/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { intents, matchEvents } from "../db/schema";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import type { StoredVector } from "../vectorstore/types";
import type { ConsumeOutcome } from "./consumer";
import { errorCodeOf } from "./errors";
import { evaluateIntent, stage2Payload } from "./evaluate";
import { sendToMatchQueue } from "./events";

const logger = createLogger();

/** match_events行の型(db/schemaの$inferSelect) */
export type MatchEventRow = typeof matchEvents.$inferSelect;

/**
 * 作成からの経過(ミリ秒)に対し、次の確認までの秒数を返す(純粋関数)。
 * 確認の時点は作成から REFLECTION_DELAYS_S の累計(2・6・14・30・60秒)、以後は
 * 最後の遅延(30秒)ごと。経過がREFLECTION_GIVE_UP_MS以上ならnull(打ち切り)。
 * 秒数は切り上げ・最小1(Queuesの遅延配信は秒単位)
 */
export const nextReflectionDelaySeconds = (
	elapsedMs: number,
): number | null => {
	if (elapsedMs >= PIPELINE.REFLECTION_GIVE_UP_MS) {
		return null;
	}
	const delays = PIPELINE.REFLECTION_DELAYS_S;
	const step = delays[delays.length - 1] ?? 30;
	let pointMs = 0;
	let index = 0;
	// 経過より後の最初の確認の時点を探す(ちょうどの時点は済んだものとして次へ)
	while (pointMs <= elapsedMs) {
		pointMs += (delays[index] ?? step) * 1000;
		index += 1;
	}
	return Math.max(1, Math.ceil((pointMs - elapsedMs) / 1000));
};

/** イベント行をprocessedへ倒す(payloadを記録) */
const markProcessed = async (
	env: Env,
	eventId: string,
	clock: Clock,
	payload: Record<string, unknown>,
): Promise<void> => {
	await drizzle(env.DB)
		.update(matchEvents)
		.set({ status: "processed", payload, processedAt: clock.now() })
		.where(eq(matchEvents.id, eventId));
};

/** イベント行をfailedへ倒す(processedAtは記録しない・consumer.tsのmarkFailedと同じ扱い) */
const markFailed = async (env: Env, eventId: string): Promise<void> => {
	await drizzle(env.DB)
		.update(matchEvents)
		.set({ status: "failed" })
		.where(eq(matchEvents.id, eventId));
};

/**
 * vector_reflectionの1件を消費する(設計 §2.3の1〜5)。
 * 1. 意思が無い・active以外・versionが違う → skippedでprocessed(評価しない)
 * 2. 自分のベクトルのmetadata.versionがイベントのversionと一致すれば反映済み
 *    (getByIdsの例外は未反映と同じに扱う・#23)
 * 3. 未反映・作成から8分未満 → 同じイベントidを次の遅延で送り直す(行はpendingのまま)。
 *    送り直しの送信が例外なら、次の遅延を{ retryDelaySeconds }で返してメッセージのretryに任せる
 * 4. 未反映・8分以上 → failed(REFLECTION_TIMEOUT)
 * 5. 反映済み → 30分抑制の例外として1回評価し、第2段の計測項目とreflect_msをpayloadへ
 */
export const consumeReflectionEvent = async (
	env: Env,
	event: MatchEventRow,
	clock: Clock,
): Promise<ConsumeOutcome> => {
	const db = drizzle(env.DB);
	const [intent] = await db
		.select()
		.from(intents)
		.where(eq(intents.id, event.sourceIntentId))
		.limit(1);
	if (intent === undefined) {
		await markProcessed(env, event.id, clock, { skipped: "not_found" });
		return;
	}
	if (intent.version !== event.version) {
		await markProcessed(env, event.id, clock, { skipped: "stale_version" });
		return;
	}
	if (intent.status !== "active") {
		await markProcessed(env, event.id, clock, { skipped: "inactive" });
		return;
	}

	let stored: StoredVector | null = null;
	try {
		[stored = null] = await createVectorStore(env).getByIds([intent.id]);
	} catch (error) {
		// 一時的な読み取りの失敗で評価し直しの連鎖を切らない(#23)。未反映として送り直す
		logger.warn("pipeline.reflection.failed", {
			error_code: errorCodeOf(error),
			intent_id: intent.id,
			layer: "get",
		});
	}
	const reflectMs = clock.now().getTime() - event.createdAt.getTime();
	// 未反映(ベクトルが無い・metadataのversionがイベントと違う)
	if (stored === null || stored.metadata.version !== event.version) {
		const delaySeconds = nextReflectionDelaySeconds(reflectMs);
		if (delaySeconds === null) {
			logger.warn("pipeline.reflection.timeout", {
				error_code: "REFLECTION_TIMEOUT",
				intent_id: intent.id,
				version: event.version,
				latency: reflectMs,
			});
			await markFailed(env, event.id);
			return;
		}
		// 送り直しの回数はメッセージに持たず、行のcreated_atからの経過で決める
		try {
			await sendToMatchQueue(env, event.id, { delaySeconds });
		} catch (error) {
			// 送れなければ受け取ったメッセージを同じ遅延でやり直す(#23・行はpendingのまま)
			logger.warn("pipeline.reflection.failed", {
				error_code: errorCodeOf(error),
				intent_id: intent.id,
				layer: "send",
			});
			return { retryDelaySeconds: delaySeconds };
		}
		return;
	}

	let result: Awaited<ReturnType<typeof evaluateIntent>>;
	try {
		result = await evaluateIntent(env, intent.id, clock, {
			vector: stored.values,
			ignoreSuppression: true,
			origin: "vector_reflection",
		});
	} catch (error) {
		logger.warn("pipeline.reflection.failed", {
			error_code: errorCodeOf(error),
			intent_id: intent.id,
			layer: "evaluate",
		});
		await markFailed(env, event.id);
		return;
	}
	logger.info("pipeline.reflection.confirmed", {
		intent_id: intent.id,
		version: event.version,
		latency: reflectMs,
	});
	await markProcessed(
		env,
		event.id,
		clock,
		result === null
			? { skipped: "not_evaluated", reflect_ms: reflectMs }
			: { ...stage2Payload(result), reflect_ms: reflectMs },
	);
};
