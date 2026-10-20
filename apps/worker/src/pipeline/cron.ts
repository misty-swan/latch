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
 * - 保持期間: match_candidates・group_candidatesの30日削除(docs/05 §2.6)
 * 評価本体はevaluateIntent・第1段はrunEmbeddingStageを再利用し、Cronからは
 * 新たな起点イベントを発行しない(直接呼び出し・docs/06 §2)。
 * (d)つながりLATCHのcompleted判定・(f)予算アラート・(i)提案クローズ後続は
 * F4/F5で計上する(docs/12)。
 */
import { PIPELINE } from "@latch/shared";
import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { groupCandidates, intents, matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { MS_PER_DAY } from "../intents/expiry";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "../vectorstore";
import { syncVectorStatus } from "../vectorstore/sync-status";
import type { StoredVector } from "../vectorstore/types";
import { type IntentRow, runEmbeddingStage } from "./consumer";
import { errorCodeOf } from "./errors";
import { evaluateIntent } from "./evaluate";

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

/** ベクトル削除のチャンク幅(getByIds/deleteByIdsの上限100に揃える) */
const VECTOR_CHUNK = 100;

/**
 * 1件分の評価を実行する。例外は1件ごとに握って続行し、Cron全体を止めない
 * (失敗はwarnログのみ・許可フィールドはintent_idとerror_code・docs/08 §6)。
 * evaluateIntentがnull(抑制・対象外)を返した場合も実行自体は成功として扱う
 */
const evaluateSafely = async (
	env: Env,
	intentId: string,
	clock: Clock,
): Promise<boolean> => {
	try {
		await evaluateIntent(env, intentId, clock);
		return true;
	} catch (error) {
		logger.warn("cron.item.failed", {
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
const runBucketSweep = async (env: Env, clock: Clock): Promise<void> => {
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
		const ok = await evaluateSafely(env, row.id, clock);
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
const runCatchUpSweep = async (env: Env, clock: Clock): Promise<void> => {
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
		await evaluateSafely(env, row.id, clock);
	}
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
		// expired化(ステートメント内でstatus=activeを再確認する)
		for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
			await db
				.update(intents)
				.set({ status: "expired" })
				.where(
					and(
						eq(intents.status, "active"),
						inArray(intents.id, ids.slice(i, i + UPDATE_CHUNK)),
					),
				);
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
 * ベクトルmetadata整合の修復(docs/06 §2「metadata更新の失敗はCronのバックフィルで
 * 回収する」)。active/paused・埋め込み済み・ベクトル未削除のIntentをgetByIds
 * (100件チャンク)で点検し、ベクトル欠損はactiveのみ再埋め込み(pausedは新規候補化の
 * 対象外のため放置)・metadata.statusの不一致は同じvaluesで現行statusへ修正upsertする
 */
const repairVectorMetadata = async (env: Env, clock: Clock): Promise<void> => {
	const db = drizzle(env.DB);
	const targets = await db
		.select()
		.from(intents)
		.where(
			and(
				inArray(intents.status, ["active", "paused"]),
				isNotNull(intents.embeddedAt),
				isNull(intents.vectorDeletedAt),
			),
		)
		.limit(PIPELINE.CRON_BATCH_LIMIT);
	const store = createVectorStore(env);
	let recovered = 0;
	for (let i = 0; i < targets.length; i += VECTOR_CHUNK) {
		const slice: IntentRow[] = targets.slice(i, i + VECTOR_CHUNK);
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
					if ((await runEmbeddingStage(env, row, clock)) === "embedded") {
						recovered += 1;
					}
				} catch (error) {
					logger.warn("cron.item.failed", {
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
		if (fixes.length > 0) {
			await store.upsert(fixes);
			recovered += fixes.length;
		}
	}
	if (recovered > 0) {
		logger.info("cron.recovered", { count: recovered });
	}
};

/**
 * (e) 埋め込みバックフィル(docs/06 §2(e))。active・埋め込み未完了で生成(更新)から
 * 5分(BACKFILL_GRACE_MS・ちょうどを含む)経過したIntentへ第1段(runEmbeddingStage:
 * 埋め込み→upsert確認→intents更新→embedding_completed投入)を直接実行し、
 * 成功時のみ続けて評価する。失敗は再試行せず次のCronで回収する(docs/06 §5)。
 * 続けてベクトルmetadata整合の修復を行う
 */
const runBackfillSweep = async (env: Env, clock: Clock): Promise<void> => {
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
	for (const row of stale) {
		try {
			if ((await runEmbeddingStage(env, row, clock)) !== "embedded") {
				continue;
			}
			await evaluateIntent(env, row.id, clock);
			backfilled += 1;
		} catch (error) {
			logger.warn("cron.item.failed", {
				intent_id: row.id,
				error_code: errorCodeOf(error),
			});
		}
	}
	if (backfilled > 0) {
		logger.info("cron.backfilled", { count: backfilled });
	}
	await repairVectorMetadata(env, clock);
};

/**
 * (g) 未評価回収(docs/06 §2(g))。埋め込み済みで未評価(last_evaluated_atがnull)の
 * active Intentを、埋め込みから5分(BACKFILL_GRACE_MS・ちょうどを含む)経過後に
 * 評価するキュー消失の安全網
 */
const runUnevaluatedSweep = async (env: Env, clock: Clock): Promise<void> => {
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
		await evaluateSafely(env, row.id, clock);
	}
};

/**
 * (h) つながりIntentの1回きり遅延再評価(docs/06 §2(h))。active化後10分
 * (DELAYED_REEVAL_AFTER_MS・ちょうどを含む)経過したつながりのactive Intentを
 * 評価し、delayed_reeval_atへ実行時刻を刻印する。刻印は評価の成否(抑制を含む)
 * に関係なく1度だけ行う(upsert反映遅延による相互取りこぼしの安全網)
 */
const runDelayedReevalSweep = async (env: Env, clock: Clock): Promise<void> => {
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
			await evaluateIntent(env, row.id, clock);
			await db
				.update(intents)
				.set({ delayedReevalAt: clock.now() })
				.where(eq(intents.id, row.id));
			reevaluated += 1;
		} catch (error) {
			logger.warn("cron.item.failed", {
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
 * 削除する(01 §21)。D1はDELETE...LIMITに対応しないため、先にCRON_BATCH_LIMITで
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
	const deleted = staleCandidates.length + staleGroups.length;
	if (deleted > 0) {
		logger.info("cron.retention.deleted", { count: deleted });
	}
};

/**
 * 毎分Cronの入口(index.tsのscheduledハンドラから呼ぶ・docs/04 §4)。
 * 各走査を順に実行する。個々のIntent評価の例外は握って続行するが、
 * 走査のクエリ自体の失敗は呼び出し元へ伝播させる(Cron起動の失敗として
 * 可視化し、次回の実行でやり直す)
 */
export const runScheduledPipeline = async (
	env: Env,
	clock: Clock,
): Promise<void> => {
	await runBucketSweep(env, clock);
	await runCatchUpSweep(env, clock);
	await runExpiryWindows(env, clock);
	await runBackfillSweep(env, clock);
	await runUnevaluatedSweep(env, clock);
	await runDelayedReevalSweep(env, clock);
	await runRetentionSweep(env, clock);
};
