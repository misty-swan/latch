/**
 * Vectorizeのmetadata.status同期(docs/06 §2)。pause/resume(routes/intents.ts)と
 * Cronの期限切れ2窓走査(pipeline/cron.ts)から使う共通ヘルパー。既存ベクトルを
 * getByIdsで取得し、同じvaluesでmetadata.statusだけを書き替えてupsertする
 * (再埋め込みはしない)。ベクトルが無い(埋め込み未実施・削除済み)場合は何もしない。
 * 同期はベストエフォートで、失敗しても呼び出し元の主処理は成功のまま
 * (06 §2「metadata更新の失敗はCronのバックフィルで回収する」)。
 * 失敗時はwarnログのみ(許可フィールド: intent_id・status・error_code・docs/08 §6)。
 * upsertの直前に意思の行を読み直し、行が無い・statusが同期先と違うときは書かない
 * (削除の後の書き戻しと、後から来た同期の古いstatusでの上書きを防ぐ・#20・設計 §5.2)
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { intents } from "../db/schema";
import type { Env } from "../env";
import { createLogger } from "../logging/logger";
import { createVectorStore } from "./index";

const logger = createLogger();

/** 同期できる遷移先のstatus(resume=active・pause=paused・Cronの期限切れ=expired) */
export type SyncableVectorStatus = "active" | "paused" | "expired";

/**
 * Vectorizeのmetadata.statusを同期する(docs/06 §2「pauseはVectorize metadataの
 * statusを即時更新して新規候補化を停止する」)。再埋め込みはせず、既存のvaluesを
 * 保ったままmetadata.statusだけを書き替える
 */
export const syncVectorStatus = async (
	env: Env,
	intentId: string,
	status: SyncableVectorStatus,
): Promise<void> => {
	try {
		const store = createVectorStore(env);
		const [existing] = await store.getByIds([intentId]);
		if (existing === null) {
			return;
		}
		const [current] = await drizzle(env.DB)
			.select({ status: intents.status })
			.from(intents)
			.where(eq(intents.id, intentId))
			.limit(1);
		if (current === undefined || current.status !== status) {
			return;
		}
		await store.upsert([
			{
				id: existing.id,
				values: existing.values,
				metadata: { ...existing.metadata, status },
			},
		]);
	} catch (error) {
		logger.warn("vector.sync.failed", {
			intent_id: intentId,
			status,
			error_code: error instanceof Error ? error.name : "UNKNOWN",
		});
	}
};
