/**
 * パイプラインの計測送信(Analytics Engine・docs/04 §4・docs/06 §7)。
 * dataset=latch_metrics(env.PIPELINE_AX)。evaluateIntent(第2段)の層通過件数・
 * Jevの呼び出しと保留・Layer 5の閾値超過・提案化の件数(F4a設計 §2.6)を
 * イベント単位のdata pointとして記録する。PIPELINE_AXが未バインドの環境
 * (単体試験等)でも例外を出さない防御を含む
 */
import type { Env } from "../env";
import type { JevHeldReason } from "../jev/runner";

/** writeStage2Metricsの入力(第2段の計測値) */
export interface Stage2MetricsData {
	/** Vectorize取得件数(自idの除外前) */
	retrievalCount: number;
	/** Layer 1通過後、上位K_vに絞り込んでLayer 3へ渡した件数 */
	l1Pass: number;
	/** Layer 1の除外理由別内訳(docs/06 §7) */
	exclusions: Record<string, number>;
	/** Layer 3通過(上位K_c)でmatch_candidatesへ保存した件数 */
	l3Pass: number;
	/** 第2段の処理時間(ミリ秒) */
	latencyMs: number;
	/** Jevの実呼び出し数(フォールバック含む・K_j以下) */
	jevCalls: number;
	/** jev_resultを再利用した件数 */
	jevReused: number;
	/** Jevの保留の理由別内訳 */
	jevHeld: Record<JevHeldReason, number>;
	/** Jev実行の処理時間(ミリ秒) */
	jevLatencyMs: number;
	/** Layer 5の閾値超過件数(ペア単位の絞り込み前) */
	l5OverThreshold: number;
	/** 提示した提案の件数 */
	proposed: number;
	/** 通知上限で保留した提案の件数 */
	held: number;
	/** 人数条件(n=2が区間外)で1対1から除外した件数(F4b設計 §2.1) */
	l4SkippedParticipants: number;
	/** グループのPoolの件数 */
	groupPool: number;
	/** 有効な集合の数 */
	groupSets: number;
	/** グループ用にJevへ渡した件数 */
	groupJevCalls: number;
	/** 判定しきれず保留した集合の数(配分の保留+判定欠け) */
	groupHeldSets: number;
	/** aggregateが閾値を超えた集合の数 */
	groupOverThreshold: number;
	/** 提示した集合の数(0または1) */
	groupProposed: number;
	/** 通知上限で保留した集合の数(0または1) */
	groupHeldProposals: number;
	/** グループ部分で例外が起きたら1 */
	groupFailed: 0 | 1;
}

/**
 * 第2段の計測を1件のdata pointとして書く(docs/06 §7の層別通過記録)。
 * blob[0]=処理段の識別("stage2")・blob[1]=Layer 1の除外理由別内訳(JSON)。
 * doubles=層通過件数(Vectorize取得→L1→L3)・処理時間・Jev(呼び出し・再利用・
 * 保留の理由別 budget/breaker/failed/cap・処理時間)・L5閾値超過・提示・保留の順。
 * その後にF4bの項目(人数条件の除外・Pool・集合・グループ用Jev・集合の保留・
 * 集合の閾値超過・集合の提示・集合の保留・グループ部分の失敗)を同順で続ける(F4b設計 §5)
 */
export const writeStage2Metrics = (env: Env, data: Stage2MetricsData): void => {
	if (env.PIPELINE_AX === undefined) {
		return;
	}
	env.PIPELINE_AX.writeDataPoint({
		blobs: ["stage2", JSON.stringify(data.exclusions)],
		doubles: [
			data.retrievalCount,
			data.l1Pass,
			data.l3Pass,
			data.latencyMs,
			data.jevCalls,
			data.jevReused,
			data.jevHeld.budget,
			data.jevHeld.breaker,
			data.jevHeld.failed,
			data.jevHeld.cap,
			data.jevLatencyMs,
			data.l5OverThreshold,
			data.proposed,
			data.held,
			data.l4SkippedParticipants,
			data.groupPool,
			data.groupSets,
			data.groupJevCalls,
			data.groupHeldSets,
			data.groupOverThreshold,
			data.groupProposed,
			data.groupHeldProposals,
			data.groupFailed,
		],
		indexes: ["stage2"],
	});
};
