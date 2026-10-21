/**
 * オフラインで操作が失敗したときの判定と固定文言(F8a設計 §1.3・§2)。
 * fetchの通信失敗はTypeErrorで届く。サーバーが答えた失敗(ApiError)は通信できているのでオフラインではない
 */

import { ApiError } from "../api/client";

/** 通信できなかった失敗か(TypeError、またはブラウザがオフラインと報告している) */
export const isOfflineError = (error: unknown): boolean => {
	if (error instanceof ApiError) return false;
	return error instanceof TypeError || navigator.onLine === false;
};

/** オフラインの案内(場面ごと) */
export const OFFLINE_MESSAGES = {
	parse: "オフラインのため、いまは読み解けません。",
	send: "オフラインのため、送れませんでした。",
	generic: "オフラインのため、いまは操作できません。",
} as const;
