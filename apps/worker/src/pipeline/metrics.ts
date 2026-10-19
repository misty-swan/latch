/**
 * パイプラインの計測送信(Analytics Engine・docs/04 §4・docs/06 §7)。
 * dataset=latch_metrics(env.PIPELINE_AX)。evaluateIntent(第2段)の層通過件数を
 * イベント単位のdata pointとして記録する。PIPELINE_AXが未バインドの環境
 * (単体試験等)でも例外を出さない防御を含む
 */
import type { Env } from "../env";

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
}

/**
 * 第2段の計測を1件のdata pointとして書く(docs/06 §7の層別通過記録)。
 * blob[0]=処理段の識別("stage2")・blob[1]=Layer 1の除外理由別内訳(JSON)。
 * doubles=層通過件数(Vectorize取得→L1→L3)と処理時間
 */
export const writeStage2Metrics = (env: Env, data: Stage2MetricsData): void => {
	if (env.PIPELINE_AX === undefined) {
		return;
	}
	env.PIPELINE_AX.writeDataPoint({
		blobs: ["stage2", JSON.stringify(data.exclusions)],
		doubles: [data.retrievalCount, data.l1Pass, data.l3Pass, data.latencyMs],
		indexes: ["stage2"],
	});
};
