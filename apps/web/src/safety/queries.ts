/**
 * 安全の送信(通報・ブロック)。docs/05(POST /v1/reports・POST /v1/users/{user_id}/block)・
 * F7c設計 §1.7・§1.8・§4。
 */

import type { ReportCreateRequest } from "@latch/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client";
import { CONNECTIONS_QUERY_KEY } from "../chat/queries";
import { latchQueryKey } from "../latches/queries";
import { BLOCKS_QUERY_KEY } from "../me/queries";
import { NOTICES_QUERY_KEY } from "../notices/queries";

/** 通報の送信(201 {received:true}) */
export const useReport = () =>
	useMutation({
		mutationFn: (body: ReportCreateRequest) =>
			apiFetch<{ received: true }>("/reports", { method: "POST", json: body }),
	});

/**
 * ブロック(201新規 / 200再適用)。効果(LATCHからの離脱・提案の取り消し)が
 * 画面に出るよう・LATCH・つながり一覧・お知らせ・ブロック一覧を取り直す
 */
export const useBlock = (latchId: string) => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (userId: string) =>
			apiFetch<unknown>(`/users/${encodeURIComponent(userId)}/block`, {
				method: "POST",
			}),
		onSettled: () => {
			for (const queryKey of [
				latchQueryKey(latchId),
				CONNECTIONS_QUERY_KEY,
				NOTICES_QUERY_KEY,
				BLOCKS_QUERY_KEY,
			]) {
				void client.invalidateQueries({ queryKey });
			}
		},
	});
};

/** 通報・ブロックの失敗文。404は理由を区別しない(相手の状態を推測させない・08 §8) */
export const safetyErrorText = (error: unknown): string =>
	error instanceof ApiError && error.code === "NOT_FOUND"
		? "この操作はできませんでした。"
		: "送れませんでした。時間をおいて、もう一度お試しください。";
