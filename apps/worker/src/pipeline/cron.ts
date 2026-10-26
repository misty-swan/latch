/**
 * 毎分Cronの本体(docs/06 §2・docs/04 §4・docs/12 Task 12)。
 * index.tsのscheduledハンドラから呼び、次の走査を順に実行する。各走査は
 * CRON_BATCH_LIMIT(500)で頭打ちにし、(status, starts_at)・(status, expires_at)等の
 * 索引で走査対象を最小化する(docs/04 §4)。
 * - (a) bucket: 機会Intentの30分バケット到来の未評価を再評価
 * - (b) catch-up: 期限前2時間以内かつ30分以上経過の機会Intentを再評価
 * - (c) 期限切れ2窓(docs/05 §2.6): expired化+候補クローズ+ベクトルmetadata同期と、
 *       期限+7日経過分のベクトル削除(vector_deleted_at記録)
 * - (e) 埋め込みバックフィルとベクトルmetadata整合の修復
 * - (g) 未評価回収(キュー消失の安全網)
 * - (h) つながりIntentの1回きり遅延再評価
 * - 保持期間: match_candidates・group_candidatesの30日削除と
 *   usage_countersの90日削除(docs/05 §2.6)
 * - (i) 回答期限切れ(expired化・yesの無効化・参加者の保留解放)と保留の期限切れ・解放
 *   (F4a設計 §3.5・§4.2)
 * - (f) Jev予算アラート(全体1日・1か月の80%・docs/06 §6)
 * - pending残留の掃査(10分経過のpendingイベントをfailedへ・docs/06 §4)
 * - (d) matchedのLATCHのcompleted判定(つながり=最終メッセージから90日・機会=対象時刻から
 *   3時間・F5設計 §2)
 * - (j) 正解データ: 閉じた提案のcalibration_recordsの作成と、観測を終えた行の確定・匿名化
 *   (docs/05 §2.2・§2.5・calibration/records.ts)
 * 評価本体はevaluateIntent・第1段はrunEmbeddingStageを再利用し、Cronからは
 * 新たな起点イベントを発行しない(直接呼び出し・docs/06 §2)。
 */
import { LATCH, LIMITS, PIPELINE } from "@latch/shared";
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ulid } from "ulid";
import { runCalibrationSweep } from "../calibration/records";
import { type Clock, jstDayKey, jstMonthKey } from "../clock/clock";
import {
	groupCandidates,
	intents,
	latches,
	latchResponses,
	matchCandidates,
	matchEvents,
	notifications,
	usageCounters,
} from "../db/schema";
import type { Env } from "../env";
import { MS_PER_DAY } from "../intents/expiry";
import { closeLatch } from "../latches/close";
import { completeDueLatches } from "../latches/complete";
import { proposeNextGroupAfterClose } from "../latches/next-group";
import { expireHeld, releaseHeld } from "../latches/release";
import { createLogger } from "../logging/logger";
import { flushPush } from "../push/dispatch";
import { pushSenderOf } from "../push/sender";
import { createVectorStore } from "../vectorstore";
import { syncVectorStatus } from "../vectorstore/sync-status";
import type { StoredVector } from "../vectorstore/types";
import { type IntentRow, runEmbeddingStage } from "./consumer";
import { errorCodeOf } from "./errors";
import { evaluateIntent } from "./evaluate";
import { createMetricsBudget, type MetricsBudget } from "./metrics-budget";
import { deleteExpiredRecentVectors } from "./recent-vectors";

const logger = createLogger();

/**
 * バケット幅のSQLリテラル(モジュール定数の埋め込みのためsql.rawで書く。
 * ユーザー入力を含まない決定的な整数値)
 */
const BUCKET_WIDTH_SQL = sql.raw(String(PIPELINE.BUCKET_WIDTH_MS));

/** 1回のUPDATEのバインド上限対策のチャンク幅(D1の上限100・docs/05冒頭の実装決定) */
const UPDATE_CHUNK = 50;

/** 候補クローズのチャンク幅(intent_a・intent_bの2列で80バインド) */
const CLOSE_CHUNK = 40;

/** ベクトル削除のチャンク幅(deleteByIds。公式の文書に上限の記載が無いため従来の100のまま) */
const VECTOR_CHUNK = 100;

/** 予算アラートのdata pointの確保数(スコープ2つ分・#28) */
const ALERT_METRICS_WRITES = 2;

/**
 * 1件分の評価を実行する。例外は1件ごとに握って続行し、Cron全体を止めない
 * (失敗はwarnログのみ・許可フィールドはintent_idとerror_code・docs/08 §6)。
 * evaluateIntentがnull(抑制・対象外)を返した場合も実行自体は成功として扱う
 */
const evaluateSafely = async (
	env: Env,
	intentId: string,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<boolean> => {
	try {
		await evaluateIntent(env, intentId, clock, { metricsBudget });
		return true;
	} catch (error) {
		logger.warn("cron.item.failed", {
			layer: "cron_evaluate",
			intent_id: intentId,
			error_code: errorCodeOf(error),
		});
		return false;
	}
};

/**
 * (a) 機会Intentのbucket到来走査(docs/06 §2(a))。starts_atが属する30分バケットの
 * 開始がnowに到達していて、last_evaluated_atがそのバケット開始より前(未評価含む)
 * activeな機会Intentを評価する。バケット開始≤nowは「starts_at<次のバケット開始」と
 * 同値(floor(now/W)*W≤now<floor(now/W)*W+W)なので、索引(status, starts_at)の
 * 範囲条件としてSQLへ押し込み、LIMITの頭打ちが未評価の取りこぼしを起こさない
 * ようにする。last_evaluated_at<バケット開始はstarts_atごとに整数演算(剰余)で
 * 算出する。期限切れ済み(expires_at≤now)は(c)のexpired化に委ねる
 */
const runBucketSweep = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const nextBucketStart = new Date(
		(Math.floor(nowMs / PIPELINE.BUCKET_WIDTH_MS) + 1) *
			PIPELINE.BUCKET_WIDTH_MS,
	);
	const rows = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				eq(intents.form, "occasion"),
				lt(intents.startsAt, nextBucketStart),
				gt(intents.expiresAt, new Date(nowMs)),
				// last_evaluated_at < 自身のstarts_atのバケット開始(starts_at−starts_at%W)。
				// 未評価(null)は常に対象
				or(
					isNull(intents.lastEvaluatedAt),
					lt(
						intents.lastEvaluatedAt,
						sql`${intents.startsAt} - (${intents.startsAt} % ${BUCKET_WIDTH_SQL})`,
					),
				),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const row of rows) {
		const ok = await evaluateSafely(env, row.id, clock, metricsBudget);
		if (ok) {
			logger.info("cron.bucket.evaluated", { intent_id: row.id });
		}
	}
};

/**
 * (b) catch-up走査(docs/06 §2(b))。期限まで2時間以内(CATCH_UP_WINDOW_MS以下・
 * ちょうどを含む)で、前回評価から30分以上(REEVALUATION_SUPPRESSION_MS以上・
 * ちょうどを含む)経過したactiveな機会Intentを評価する。未評価(null)も対象。
 * 期限切れ済みは(c)に委ねる。つながりIntentはbucket・catch-upの対象外
 * (docs/06 §2「catch-up・bucketは機会Intentのみ」)
 */
const runCatchUpSweep = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const rows = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				eq(intents.form, "occasion"),
				gt(intents.expiresAt, new Date(nowMs)),
				lte(intents.expiresAt, new Date(nowMs + PIPELINE.CATCH_UP_WINDOW_MS)),
				or(
					isNull(intents.lastEvaluatedAt),
					lte(
						intents.lastEvaluatedAt,
						new Date(nowMs - PIPELINE.REEVALUATION_SUPPRESSION_MS),
					),
				),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const row of rows) {
		await evaluateSafely(env, row.id, clock, metricsBudget);
	}
};

/**
 * intent_expiredのアプリ内通知を1件書く文(F7b設計 §5.7)。IDはULIDをJS側で採番するため
 * Intent1件につき1文。status=expiredのIntentだけを選び、UNIQUE(intent_id, type)の
 * 競合は無視する(再実行・再走査で二重に作らない)。列順はnotificationsの定義順
 * (id・user_id・type・latch_id・read_at・created_at・intent_id・push_state・push_attempted_at)
 */
export const intentExpiredInsert = (
	db: ReturnType<typeof drizzle>,
	intentId: string,
	now: Date,
) =>
	db
		.insert(notifications)
		.select(
			sql`SELECT ${ulid()} AS id, user_id, 'intent_expired' AS type, NULL AS latch_id,
				NULL AS read_at, ${now.getTime()} AS created_at, id AS intent_id,
				'none' AS push_state, NULL AS push_attempted_at
				FROM intents WHERE id = ${intentId} AND status = 'expired'`,
		)
		.onConflictDoNothing();

/**
 * Pushの回収(F7b設計 §5.6)。作成から10分を過ぎたpendingは試行を打ち切ってfailedへ倒し、
 * 残りのうち作成から30秒以上のものを再送する(送信直後の起動と競合しない間隔)
 */
export const runPushSweep = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	await db
		.update(notifications)
		.set({ pushState: "failed" })
		.where(
			and(
				eq(notifications.pushState, "pending"),
				lt(notifications.createdAt, new Date(now.getTime() - 10 * 60_000)),
			),
		);
	await flushPush(db, pushSenderOf(env), clock, { minAgeMs: 30_000 });
};

/**
 * (c) 期限切れ2窓走査(docs/05 §2.6)。索引(status, expires_at)で
 * 第1窓「expired化対象(expires_at≤now)」と第2窓「ベクトル削除対象
 * (expires_at≤now−7日・vector_deleted_at IS NULL)」を走査する。
 * 第1窓: 候補クローズ→expired化→ベクトルmetadata.statusの同期(best-effort)。
 * 候補クローズを先に行うのは、途中失敗でexpired化だけが先行した場合に
 * 残った候補行のクローズが再試行できなくなるため(次回のCronで収束する)。
 * 第2窓: ベクトル削除を先に実行し、成功後にvector_deleted_atへ記録する
 * (記録が先行すると削除済みでも再試行できなくなるため)
 */
const runExpiryWindows = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const now = new Date(nowMs);

	// 第1窓: active・expires_at≤now
	const expiring = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				isNotNull(intents.expiresAt),
				lte(intents.expiresAt, now),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	if (expiring.length > 0) {
		const ids = expiring.map((row) => row.id);
		// 1対1候補のクローズ: 当該Intentをintent_a/bに含むstatus=candidateの行。
		// intent_a・intent_bの2列で80バインドに収まるよう40件ずつ分割する
		for (let i = 0; i < ids.length; i += CLOSE_CHUNK) {
			const slice = ids.slice(i, i + CLOSE_CHUNK);
			await db
				.update(matchCandidates)
				.set({ status: "closed" })
				.where(
					and(
						eq(matchCandidates.status, "candidate"),
						or(
							inArray(matchCandidates.intentAId, slice),
							inArray(matchCandidates.intentBId, slice),
						),
					),
				);
		}
		// グループ候補のクローズ: 当該Intentをintent_idsに含むstatus=candidateの行。
		// intent_idsはJSON配列列で索引が無いため、candidate行自体は保持期間(30日)で
		// 上限づけられた小さい表であることを前提に、candidate行だけを取得して
		// JS側で照合する(expireがあるときだけ走査し・CRON_BATCH_LIMITで頭打ち)
		const groupRows = await db
			.select()
			.from(groupCandidates)
			.where(eq(groupCandidates.status, "candidate"))
			.limit(PIPELINE.CRON_BATCH_LIMIT);
		const idSet = new Set(ids);
		const closingGroups = groupRows
			.filter((row) => row.intentIds.some((id) => idSet.has(id)))
			.map((row) => row.id);
		for (let i = 0; i < closingGroups.length; i += UPDATE_CHUNK) {
			await db
				.update(groupCandidates)
				.set({ status: "closed" })
				.where(
					inArray(groupCandidates.id, closingGroups.slice(i, i + UPDATE_CHUNK)),
				);
		}
		// expired化(ステートメント内でstatus=activeを再確認する)。同じ1バッチに
		// intent_expiredのアプリ内通知を置く(expired化が0行なら書かれない・F7b設計 §5.7)
		for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
			const chunk = ids.slice(i, i + UPDATE_CHUNK);
			await db.batch([
				db
					.update(intents)
					.set({ status: "expired" })
					.where(and(eq(intents.status, "active"), inArray(intents.id, chunk))),
				...chunk.map((id) => intentExpiredInsert(db, id, now)),
			]);
		}
		// ベクトルmetadata.statusの同期(best-effort・docs/06 §2)
		for (const row of expiring) {
			await syncVectorStatus(env, row.id, "expired");
		}
		logger.info("cron.expired", { count: expiring.length });
	}

	// 第2窓: expired・expires_at≤now−7日・ベクトル削除未実行
	const deletable = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "expired"),
				isNotNull(intents.expiresAt),
				lte(
					intents.expiresAt,
					new Date(nowMs - PIPELINE.VECTOR_DELETE_DELAY_DAYS * MS_PER_DAY),
				),
				isNull(intents.vectorDeletedAt),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	if (deletable.length > 0) {
		const store = createVectorStore(env);
		for (let i = 0; i < deletable.length; i += VECTOR_CHUNK) {
			await store.deleteByIds(
				deletable.slice(i, i + VECTOR_CHUNK).map((row) => row.id),
			);
		}
		// 削除実行の記録(docs/05 §2.6の2窓走査用)。削除の後に記録する
		const deletedAt = clock.now();
		for (let i = 0; i < deletable.length; i += UPDATE_CHUNK) {
			await db
				.update(intents)
				.set({ vectorDeletedAt: deletedAt })
				.where(
					inArray(
						intents.id,
						deletable.slice(i, i + UPDATE_CHUNK).map((row) => row.id),
					),
				);
		}
		logger.info("cron.vectors.deleted", { count: deletable.length });
	}
};

/**
 * ベクトルmetadata整合の修復(docs/06 §2「metadata更新の失敗はCronのmetadata整合の
 * 修復で回収する」・バックフィル(e)の後の独立した走査)。active/paused・埋め込み済み・ベクトル未削除のIntentをgetByIds
 * (VECTOR_GET_MAX件ずつ)で点検し、ベクトル欠損はactiveのみ再埋め込み(pausedは新規候補化の
 * 対象外のため放置)・metadata.statusの不一致は同じvaluesで現行statusへ修正upsertする。
 * 反映待ちの意思(埋め込みからREPAIR_GRACE_MS以内・または現在のversionの反映確認が
 * pending)は点検しない(#13・#21)
 */
const repairVectorMetadata = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	// 埋め込みから10分以内はVectorizeへの反映待ちでベクトルが見えないことがあるため
	// 点検しない(#13・反映確認vector_reflectionが扱う)。打ち切り(REFLECTION_GIVE_UP_MS)
	// とは別の値にし、打ち切りを変えても修復の除外が縮まないようにする(#21)
	const settledBefore = new Date(
		clock.now().getTime() - PIPELINE.REPAIR_GRACE_MS,
	);
	// 現在のversionの反映確認がまだpendingの意思は、経過によらず反映確認に任せる(#21)
	const reflectionPending = db
		.select({ id: matchEvents.id })
		.from(matchEvents)
		.where(
			and(
				eq(matchEvents.eventType, "vector_reflection"),
				eq(matchEvents.sourceIntentId, intents.id),
				eq(matchEvents.version, intents.version),
				eq(matchEvents.status, "pending"),
			),
		);
	const targets = await db
		.select()
		.from(intents)
		.where(
			and(
				inArray(intents.status, ["active", "paused"]),
				isNotNull(intents.embeddedAt),
				lte(intents.embeddedAt, settledBefore),
				isNull(intents.vectorDeletedAt),
				notExists(reflectionPending),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	const store = createVectorStore(env);
	let recovered = 0;
	for (let i = 0; i < targets.length; i += PIPELINE.VECTOR_GET_MAX) {
		const slice: IntentRow[] = targets.slice(i, i + PIPELINE.VECTOR_GET_MAX);
		const vectors = await store.getByIds(slice.map((row) => row.id));
		const fixes: StoredVector[] = [];
		for (let j = 0; j < slice.length; j += 1) {
			const row = slice[j];
			const vector = vectors[j] ?? null;
			if (vector === null) {
				if (row.status !== "active") {
					continue;
				}
				try {
					const stage = await runEmbeddingStage(env, row, clock, {
						emitCompleted: false,
						source: "repair",
						// upsertのやり直しの待ち(#44)は応答の後の第1段のためのもの。Cronでは待たずに
						// 次の分に回し、後ろの走査を押さない
						upsertRetryDelaysMs: [],
					});
					if (stage.status === "embedded") {
						recovered += 1;
					}
				} catch (error) {
					logger.warn("cron.item.failed", {
						layer: "cron_repair",
						intent_id: row.id,
						error_code: errorCodeOf(error),
					});
				}
				continue;
			}
			if (vector.metadata.status !== row.status) {
				fixes.push({
					id: vector.id,
					values: vector.values,
					metadata: { ...vector.metadata, status: row.status },
				});
			}
		}
		// upsertの直前に意思の行を読み直し、消えた・statusが変わった意思は書かない。
		// 点検の後の削除でベクトルを書き戻したり、後から来たpause/resumeの同期を古い
		// statusで上書きしたりしない(#20・設計 §5.2)。変わった意思は次の実行で点検する
		const current =
			fixes.length === 0
				? []
				: await db
						.select({ id: intents.id, status: intents.status })
						.from(intents)
						.where(
							inArray(
								intents.id,
								fixes.map((fix) => fix.id),
							),
						);
		const statusById = new Map(current.map((row) => [row.id, row.status]));
		const stillValid = fixes.filter(
			(fix) => statusById.get(fix.id) === fix.metadata.status,
		);
		if (stillValid.length > 0) {
			await store.upsert(stillValid);
			recovered += stillValid.length;
		}
	}
	if (recovered > 0) {
		logger.info("cron.recovered", { count: recovered });
	}
};

/**
 * (e) 埋め込みバックフィル(docs/06 §2(e))。active・埋め込み未完了で生成(更新)から
 * 5分(BACKFILL_GRACE_MS・ちょうどを含む)経過したIntentへ第1段(runEmbeddingStage:
 * 埋め込み→upsert→intents更新→反映確認の投入)を直接実行し、成功時のみ続けて評価する。
 * 評価には第1段が返したベクトルを渡し、本人のベクトルの反映を待たない(#22)。評価が
 * null(抑制・対象外)のときはbackfilledに数えない。
 * 直後に評価するためembedding_completedは投入しない(emitCompleted:false。投入すると
 * キュー経由の評価と二重になる)。当回の失敗はやり直さず次のCronで回収する(docs/06 §5)。
 * Embeddingの失敗が連続BACKFILL_FAILURE_ABORT(5)件に達したら当回の走査を打ち切る
 * (障害中に500件を空振りしない・docs/06 §4)。成功を挟めば連続数は0に戻る。
 */
const runBackfillSweep = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const stale = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				isNull(intents.embeddedAt),
				lte(intents.updatedAt, new Date(nowMs - PIPELINE.BACKFILL_GRACE_MS)),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	let backfilled = 0;
	let failed = 0;
	let consecutiveFailures = 0;
	for (const row of stale) {
		try {
			const stage = await runEmbeddingStage(env, row, clock, {
				emitCompleted: false,
				source: "backfill",
				// upsertのやり直しの待ち(#44)は応答の後の第1段のためのもの。Cronでは待たずに
				// 次の分に回し、後ろの走査を押さない
				upsertRetryDelaysMs: [],
			});
			// 埋め込みの間に削除・一時停止・版の更新があった意思は書かずに止めた(失敗に数えない・#20)
			if (stage.status === "gone") {
				continue;
			}
			if (stage.status !== "embedded") {
				failed += 1;
				consecutiveFailures += 1;
				if (consecutiveFailures >= LATCH.BACKFILL_FAILURE_ABORT) {
					// count=打ち切り時点までの当回の失敗件数
					logger.warn("cron.backfill.aborted", { count: failed });
					break;
				}
				continue;
			}
			consecutiveFailures = 0;
			const evaluated = await evaluateIntent(env, row.id, clock, {
				vector: stage.vector,
				origin: "cron_backfill",
				metricsBudget,
			});
			if (evaluated !== null) {
				backfilled += 1;
			}
		} catch (error) {
			logger.warn("cron.item.failed", {
				layer: "cron_backfill",
				intent_id: row.id,
				error_code: errorCodeOf(error),
			});
		}
	}
	if (backfilled > 0) {
		logger.info("cron.backfilled", { count: backfilled });
	}
};

/**
 * (g) 未評価回収(docs/06 §2(g))。埋め込み済みで未評価(last_evaluated_atがnull)の
 * active Intentを、埋め込みから5分(BACKFILL_GRACE_MS・ちょうどを含む)経過後に
 * 評価するキュー消失の安全網
 */
const runUnevaluatedSweep = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const rows = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				isNotNull(intents.embeddedAt),
				isNull(intents.lastEvaluatedAt),
				lte(intents.embeddedAt, new Date(nowMs - PIPELINE.BACKFILL_GRACE_MS)),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (const row of rows) {
		await evaluateSafely(env, row.id, clock, metricsBudget);
	}
};

/**
 * (h) つながりIntentの1回きり遅延再評価(docs/06 §2(h))。active化後10分
 * (DELAYED_REEVAL_AFTER_MS・ちょうどを含む)経過したつながりのactive Intentを
 * 評価し、delayed_reeval_atへ実行時刻を刻印する。刻印は評価の成否(抑制を含む)
 * に関係なく1度だけ行う(upsert反映遅延による相互取りこぼしの安全網)。
 * 評価は30分の再評価抑制の例外として行う(#10・埋め込み直後の評価に抑制されない)
 */
const runDelayedReevalSweep = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const nowMs = clock.now().getTime();
	const rows = await db
		.select()
		.from(intents)
		.where(
			and(
				eq(intents.status, "active"),
				eq(intents.form, "connection"),
				isNotNull(intents.embeddedAt),
				isNotNull(intents.lastEvaluatedAt),
				isNull(intents.delayedReevalAt),
				lte(
					intents.embeddedAt,
					new Date(nowMs - PIPELINE.DELAYED_REEVAL_AFTER_MS),
				),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	let reevaluated = 0;
	for (const row of rows) {
		try {
			// 30分の再評価抑制の例外(#10)。埋め込みの直後に評価済み(last_evaluated_atが
			// 約10分前)という通常の状態でも評価する
			await evaluateIntent(env, row.id, clock, {
				ignoreSuppression: true,
				origin: "cron_delayed",
				metricsBudget,
			});
			await db
				.update(intents)
				.set({ delayedReevalAt: clock.now() })
				.where(eq(intents.id, row.id));
			reevaluated += 1;
		} catch (error) {
			logger.warn("cron.item.failed", {
				layer: "cron_delayed_reeval",
				intent_id: row.id,
				error_code: errorCodeOf(error),
			});
		}
	}
	if (reevaluated > 0) {
		logger.info("cron.reeval.delayed", { count: reevaluated });
	}
};

/**
 * 保持期間削除(docs/05 §2.6)。1対1候補は評価確定から30日
 * (updated_at≤now−30日)・グループ候補は生成から30日(created_at≤now−30日)で
 * 削除する(01 §21)。usage_countersはperiodの日付がnowのJST日付より90日
 * (COUNTER_RETENTION_DAYS)超古い行を削除する。D1はDELETE...LIMITに対応しないため、先にCRON_BATCH_LIMITで
 * 削除対象のidを取得してからinArrayで削除する(1実行あたりの処理量を
 * CRON_BATCH_LIMITで頭打ちにし、超過分は次回のCronで回収する・docs/04 §4)
 */
const runRetentionSweep = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const cutoff = new Date(
		clock.now().getTime() - PIPELINE.CANDIDATE_RETENTION_DAYS * MS_PER_DAY,
	);
	const staleCandidates = await db
		.select({ id: matchCandidates.id })
		.from(matchCandidates)
		.where(lte(matchCandidates.updatedAt, cutoff))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (let i = 0; i < staleCandidates.length; i += UPDATE_CHUNK) {
		await db.delete(matchCandidates).where(
			inArray(
				matchCandidates.id,
				staleCandidates.slice(i, i + UPDATE_CHUNK).map((row) => row.id),
			),
		);
	}
	const staleGroups = await db
		.select({ id: groupCandidates.id })
		.from(groupCandidates)
		.where(lte(groupCandidates.createdAt, cutoff))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (let i = 0; i < staleGroups.length; i += UPDATE_CHUNK) {
		await db.delete(groupCandidates).where(
			inArray(
				groupCandidates.id,
				staleGroups.slice(i, i + UPDATE_CHUNK).map((row) => row.id),
			),
		);
	}
	// usage_counters: 日次(YYYY-MM-DD)・時間(YYYY-MM-DD-HH)は先頭10文字の日付で、
	// 月次(YYYY-MM)はその月の末日で判定する(末日<cutoff ⇔ 月<cutoffの年月)。
	// 1日あたりの行数はIntent・ユーザー数で上限づけられるため一括で削除する
	const counterCutoff = jstDayKey(
		new Date(clock.now().getTime() - LATCH.COUNTER_RETENTION_DAYS * MS_PER_DAY),
	);
	const counterResult = await db
		.delete(usageCounters)
		.where(
			or(
				and(
					sql`length(${usageCounters.period}) >= 10`,
					sql`substr(${usageCounters.period}, 1, 10) < ${counterCutoff}`,
				),
				and(
					sql`length(${usageCounters.period}) = 7`,
					sql`${usageCounters.period} < ${counterCutoff.slice(0, 7)}`,
				),
			),
		);
	const deleted =
		staleCandidates.length +
		staleGroups.length +
		(counterResult.meta.changes ?? 0);
	if (deleted > 0) {
		logger.info("cron.retention.deleted", { count: deleted });
	}
	// 直近のベクトルの控え(#47)は埋め込みから15分で消す。行数は15分間に埋め込んだ意思の数で
	// 上限づけられるため一括で削除する(上の件数と分けて数える)
	const recentDeleted = await deleteExpiredRecentVectors(env.DB, clock.now());
	if (recentDeleted > 0) {
		logger.info("cron.retention.recent_vectors_deleted", {
			count: recentDeleted,
		});
	}
};

/**
 * (i) 回答期限切れ走査(F4a設計 §4.2・docs/06 §4)。proposed・partial_acceptで
 * response_deadline≤now(ちょうどを含む)のLATCHを期限の古い順に最大500件expiredで閉じる
 * (proposal_history=expired・提示済みのため参加者へclosed通知)。閉じられた場合に限り、
 * 有効なyes(retracted_at IS NULL)を無効化する。参加者の保留(candidate)の解放は直後の
 * 保留走査(runHeldSweep)が全体で拾う。閉じたLATCHのidは closedIds へ積み、次集合の提案は
 * 保留走査の後に runNextGroupSweep が行う(他のクローズ経路と同じく保留の解放を先にする)。
 * 1件の例外は握って続行する(latch_id・error_codeのみをログ・docs/08 §6)
 */
const runResponseDeadlineSweep = async (
	env: Env,
	clock: Clock,
	closedIds: string[],
): Promise<void> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	const rows = await db
		.select({ id: latches.id })
		.from(latches)
		.where(
			and(
				inArray(latches.status, ["proposed", "partial_accept"]),
				lte(latches.responseDeadline, now),
			),
		)
		.orderBy(asc(latches.responseDeadline), asc(latches.id))
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	let expired = 0;
	for (const { id } of rows) {
		try {
			const closed = await closeLatch(
				db,
				id,
				"expired",
				// 有効なyesを持たない参加者を含むペアだけを記録する(F4b設計 §3.2・オーナー裁定2)。
				// yesの判定はクローズのバッチ内で読むため、yesの無効化はこの後に行う
				{ kind: "non_yes", outcome: "expired" },
				["proposed", "partial_accept"],
				now,
			);
			if (!closed) {
				continue;
			}
			await db
				.update(latchResponses)
				.set({ retractedAt: now })
				.where(
					and(
						eq(latchResponses.latchId, id),
						eq(latchResponses.response, "yes"),
						isNull(latchResponses.retractedAt),
					),
				);
			// 参加者の保留の解放は直後の保留走査(runHeldSweep)が全体で拾い、
			// 次集合の提案はその後に行う(runNextGroupSweep)
			closedIds.push(id);
			expired += 1;
		} catch (error) {
			logger.warn("cron.item.failed", {
				layer: "cron_answer_expire",
				latch_id: id,
				error_code: errorCodeOf(error),
			});
		}
	}
	if (expired > 0) {
		logger.info("cron.latches.expired", { count: expired });
	}
};

/**
 * 保留の期限切れと解放(F4a設計 §3.5)。expireHeldで全体の期限切れを先に閉じ、
 * 続けてreleaseHeldで全体の保留を提示の上限に従って昇格する
 */
const runHeldSweep = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	await expireHeld(db, now);
	const released = await releaseHeld(db, now);
	if (released > 0) {
		logger.info("cron.held.released", { count: released });
	}
};

/**
 * 回答期限切れで閉じたグループ提案ごとに、評価済みの次の集合を提案する(F4b設計 §3.5)。
 * 保留走査の後に呼ぶ。1件の失敗はproposeNextGroupAfterClose内でログへ出して握る
 */
const runNextGroupSweep = async (
	env: Env,
	clock: Clock,
	closedIds: string[],
): Promise<void> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	for (const id of closedIds) {
		await proposeNextGroupAfterClose(db, id, now);
	}
};

/** 予算アラートの送信済み印の有効期限(秒)。日次は2日・月次は40日で自然消滅させる */
const ALERT_TTL_SECONDS = {
	jev_global_daily: 2 * 24 * 60 * 60,
	jev_global_monthly: 40 * 24 * 60 * 60,
} as const;

/**
 * (f) Jev予算アラート(docs/06 §6)。当日の全体1日・当月の全体1か月のカウンタが
 * 上限×BUDGET_ALERT_RATIO(80%)以上なら、期間ごとに1回だけwarnログと
 * Analytics Engineの1点を出す。送信済みの印はKV `jev:alert:<scope>:<period>` に置く。
 * Analytics Engineには識別子を入れない(scopeと件数のみ・docs/08 §6)
 */
const runBudgetAlert = async (
	env: Env,
	clock: Clock,
	metricsBudget: MetricsBudget,
): Promise<void> => {
	const db = drizzle(env.DB);
	const now = clock.now();
	const targets = [
		{
			scope: "jev_global_daily",
			period: jstDayKey(now),
			limit: LIMITS.JEV_GLOBAL_DAILY,
		},
		{
			scope: "jev_global_monthly",
			period: jstMonthKey(now),
			limit: LIMITS.JEV_GLOBAL_MONTHLY,
		},
	] as const;
	for (const target of targets) {
		const [row] = await db
			.select({ count: usageCounters.count })
			.from(usageCounters)
			.where(
				and(
					eq(usageCounters.scope, target.scope),
					eq(usageCounters.key, "-"),
					eq(usageCounters.period, target.period),
				),
			);
		const count = row?.count ?? 0;
		if (count < target.limit * LATCH.BUDGET_ALERT_RATIO) {
			continue;
		}
		const key = `jev:alert:${target.scope}:${target.period}`;
		if ((await env.PIPELINE_KV.get(key)) !== null) {
			continue;
		}
		logger.warn("jev.budget.alert", { layer: target.scope, count });
		// PIPELINE_AXが未バインドの環境では送信を省略する(metrics.tsと同じ防御)
		// 1回の実行の書き込みの残りが無ければ省く(警告ログとKVの印は残す・#28)
		if (metricsBudget.take(1)) {
			env.PIPELINE_AX?.writeDataPoint({
				blobs: ["jev_budget_alert", target.scope],
				doubles: [count, target.limit],
				indexes: ["jev_budget_alert"],
			});
		}
		await env.PIPELINE_KV.put(key, "1", {
			expirationTtl: ALERT_TTL_SECONDS[target.scope],
		});
	}
};

/**
 * pending残留の掃査(docs/06 §4)。status=pendingのままcreated_atから10分
 * (PENDING_STALE_MS・ちょうどを含む)経過したイベント行を最大500件failedへ倒す
 * (キュー消失の可視化。評価の回収はバックフィル・未評価回収が担う)。
 * processed_atは記録しない(markFailedと同じ扱い)
 */
const runPendingSweep = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const cutoff = new Date(clock.now().getTime() - LATCH.PENDING_STALE_MS);
	const stale = await db
		.select({ id: matchEvents.id })
		.from(matchEvents)
		.where(
			and(
				eq(matchEvents.status, "pending"),
				lte(matchEvents.createdAt, cutoff),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	for (let i = 0; i < stale.length; i += UPDATE_CHUNK) {
		await db
			.update(matchEvents)
			.set({ status: "failed" })
			.where(
				and(
					eq(matchEvents.status, "pending"),
					inArray(
						matchEvents.id,
						stale.slice(i, i + UPDATE_CHUNK).map((row) => row.id),
					),
				),
			);
	}
	if (stale.length > 0) {
		logger.info("cron.pending.failed", { count: stale.length });
	}
};

/**
 * 走査を隔離して実行する。失敗はwarnログ(cron.sweep.failed・layer=走査名・
 * error_code)を出して握り、次の走査へ進む(1つの走査の失敗で後続の走査を止めない)
 */
const runIsolated = async (
	layer: string,
	sweep: () => Promise<void>,
): Promise<void> => {
	try {
		await sweep();
	} catch (error) {
		logger.warn("cron.sweep.failed", {
			layer,
			error_code: errorCodeOf(error),
		});
	}
};

/**
 * 毎分Cronの入口(index.tsのscheduledハンドラから呼ぶ・docs/04 §4)。
 * 各走査を順に実行する。個々のIntent評価の例外は握って続行し、走査ごとの失敗も
 * runIsolatedで隔離してログ(cron.sweep.failed・layer=走査名)に出し、後ろの走査を止めない
 * (前半の走査の失敗が後ろを巻き込んで毎分Cronが止まった不具合の修正・#15)。
 * 回答期限切れで閉じたグループ提案の次集合の提案は保留走査の後(F4b設計 §3.5)
 */
export const runScheduledPipeline = async (
	env: Env,
	clock: Clock,
): Promise<void> => {
	// この実行の中で作られた通知(Cronの評価で作った提案など)だけを後でその場で送るための起点
	const startedAt = clock.now();
	// この実行の計測の書き込みの残り(実行ごとに作る・同時に動く別の実行と共有しない・#28)
	// 予算アラートの書き込み2件(スコープごとに1件)は先に確保し、評価の計測で使い切られても書けるようにする
	const alertBudget = createMetricsBudget(ALERT_METRICS_WRITES);
	const metricsBudget = createMetricsBudget(
		PIPELINE.METRICS_WRITES_PER_INVOCATION - ALERT_METRICS_WRITES,
	);
	await runIsolated("bucket", () => runBucketSweep(env, clock, metricsBudget));
	await runIsolated("catch_up", () =>
		runCatchUpSweep(env, clock, metricsBudget),
	);
	await runIsolated("expiry", () => runExpiryWindows(env, clock));
	await runIsolated("backfill", () =>
		runBackfillSweep(env, clock, metricsBudget),
	);
	await runIsolated("repair", () => repairVectorMetadata(env, clock));
	await runIsolated("unevaluated", () =>
		runUnevaluatedSweep(env, clock, metricsBudget),
	);
	await runIsolated("delayed", () =>
		runDelayedReevalSweep(env, clock, metricsBudget),
	);
	await runIsolated("retention", () => runRetentionSweep(env, clock));
	// 回答期限切れで閉じたLATCHのid。走査が途中で失敗しても、閉じた分は次集合の提案へ渡す
	const deadlineClosedIds: string[] = [];
	await runIsolated("response_deadline", () =>
		runResponseDeadlineSweep(env, clock, deadlineClosedIds),
	);
	await runIsolated("held", () => runHeldSweep(env, clock));
	await runIsolated("next_group", () =>
		runNextGroupSweep(env, clock, deadlineClosedIds),
	);
	// この実行で作った通知のWeb Pushは30秒の回収を待たずに送る(#9)
	await runIsolated("push_fresh", async () => {
		await flushPush(drizzle(env.DB), pushSenderOf(env), clock, {
			minAgeMs: 0,
			createdFrom: startedAt,
		});
	});
	await runIsolated("budget_alert", () =>
		runBudgetAlert(env, clock, alertBudget),
	);
	await runIsolated("pending", () => runPendingSweep(env, clock));
	await runIsolated("completion", async () => {
		await completeDueLatches(drizzle(env.DB), clock.now());
	});
	// 正解データは閉じた提案の後に作る(この実行で閉じた・completedにした提案も拾う)
	// 観測中の行の点検は照会が多いため毎時0分だけ行う(退会・Intent削除はその場で匿名化する)
	await runIsolated("calibration", async () => {
		const now = clock.now();
		await runCalibrationSweep(drizzle(env.DB), now, {
			checkLinked: now.getUTCMinutes() === 0,
		});
	});
	// Pushの回収は外部への送信を含み時間がかかり得るので最後に置く(completed判定を遅らせない)
	await runIsolated("push", () => runPushSweep(env, clock));
};
