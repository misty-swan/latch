/**
 * 意思の削除と退会のベクトルの削除を短く待ってやり直す(LAT-126・docs/05 §2.5)。
 * Vectorizeは書き込みの頻度の上限に当たるとVECTOR_DELETE_40041で失敗する(LAT-100の調べ)。
 * 上限は数十秒続くこともあるため完全には防げないが、一瞬の重なりはここで吸収する。
 * 尽きたら最後の例外を投げ、呼び出し側が40041なら503・それ以外は500で中断する
 */
import { PIPELINE } from "@latch/shared";
import type { Sleep } from "../clock/clock";
import { errorCodeOf } from "../pipeline/errors";
import type { VectorStore } from "./types";

/** 試験専用: やり直しの待ちの既定を差し替える(未設定なら定数・nullで戻す) */
let retryDelaysOverride: readonly number[] | null = null;
export const setVectorDeleteRetryDelaysForTest = (
	delays: readonly number[] | null,
): void => {
	retryDelaysOverride = delays;
};

/**
 * deleteByIdsを呼び、失敗したら待ち(既定はPIPELINE.VECTOR_DELETE_RETRY_DELAYS_MSの0.5秒・1秒)を
 * 順に置いてやり直す。全部失敗したら最後の例外を投げる
 */
export const deleteVectorsWithRetry = async (
	store: VectorStore,
	ids: string[],
	sleep: Sleep,
	retryDelaysMs: readonly number[] = retryDelaysOverride ??
		PIPELINE.VECTOR_DELETE_RETRY_DELAYS_MS,
): Promise<void> => {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await store.deleteByIds(ids);
			return;
		} catch (error) {
			const delay = retryDelaysMs[attempt];
			if (delay === undefined) {
				throw error;
			}
			await sleep(delay);
		}
	}
};

/** ベクトルの削除の失敗が書き込みの頻度の上限(VECTOR_DELETE_40041)によるものか */
export const isVectorDeleteRateLimited = (error: unknown): boolean =>
	errorCodeOf(error) === "VECTOR_DELETE_40041";
