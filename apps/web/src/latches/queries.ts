/**
 * LATCH(提案〜成立)の取得・送信(TanStack Query)。docs/05 §3.4(/v1/latches)。
 * 送信系は成功時に応答のLatchDTOを個別キャッシュへ反映し・一覧とIntent一覧を無効化する。
 */

import type { DeferReason, LatchDTO } from "@latch/shared";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client";
import { INTENTS_QUERY_KEY } from "../intents/queries";

export const LATCHES_QUERY_KEY = ["latches"] as const;
export const latchQueryKey = (id: string) => ["latches", id] as const;
export const PROPOSALS_QUERY_KEY = ["latches", "proposals"] as const;

/** GET /v1/latchesの応答 */
export type LatchListResponse = {
	items: LatchDTO[];
	next_cursor: string | null;
};

/** 回答待ちの提案一覧(先頭50件) */
export const useProposalsQuery = () =>
	useQuery({
		queryKey: PROPOSALS_QUERY_KEY,
		queryFn: () =>
			apiFetch<LatchListResponse>("/latches?type=proposals&limit=50"),
	});

/** 再試行の上限(QueryClientが既定を持たないときのTanStack Queryの既定と同じ3回) */
const MAX_RETRIES = 3;

/** QueryClientの既定の再試行(試験ではfalse)に従うか。404(NOT_FOUND)だけは常に再試行しない */
const shouldRetry = (
	base: unknown,
	failureCount: number,
	error: Error,
): boolean => {
	if (error instanceof ApiError && error.code === "NOT_FOUND") return false;
	if (typeof base === "function") return Boolean(base(failureCount, error));
	if (typeof base === "boolean") return base;
	if (typeof base === "number") return failureCount < base;
	return failureCount < MAX_RETRIES;
};

/**
 * LATCH1件。相手の回答待ちなどで定期再取得したいときrefetchIntervalを渡す。
 * 404(NOT_FOUND)は再試行しても変わらないため・すぐ見つからない表示へ進める
 */
export const useLatchQuery = (
	id: string,
	options?: { refetchInterval?: number | false },
) => {
	const client = useQueryClient();
	const base = client.getDefaultOptions().queries?.retry;
	return useQuery({
		queryKey: latchQueryKey(id),
		queryFn: () => apiFetch<LatchDTO>(`/latches/${id}`),
		retry: (failureCount, error) => shouldRetry(base, failureCount, error),
		refetchOnWindowFocus: true,
		refetchInterval: options?.refetchInterval ?? false,
	});
};

/** 応答を個別キャッシュへ置き、関連する一覧を無効化する */
const applyResult = (client: QueryClient, id: string, data: LatchDTO): void => {
	client.setQueryData(latchQueryKey(id), data);
	void client.invalidateQueries({ queryKey: LATCHES_QUERY_KEY });
	void client.invalidateQueries({ queryKey: INTENTS_QUERY_KEY });
};

const usePost = <V>(
	id: string,
	path: string,
	toBody: (variables: V) => unknown,
) => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (variables: V) =>
			apiFetch<LatchDTO>(`/latches/${id}${path}`, {
				method: "POST",
				json: toBody(variables),
			}),
		onSuccess: (data) => applyResult(client, id, data),
	});
};

/** 回答(yes=参加する / defer=今回は見送る。noはUIに置かない) */
export const useRespondMutation = (id: string) =>
	usePost<"yes" | "defer">(id, "/response", (response) => ({ response }));

/** 回答の取り消し */
export const useRetractMutation = (id: string) =>
	usePost<void>(id, "/response/retract", () => undefined);

/** 見送りの理由 */
export const useDeferReasonMutation = (id: string) =>
	usePost<DeferReason>(id, "/defer-reason", (reason) => ({ reason }));
