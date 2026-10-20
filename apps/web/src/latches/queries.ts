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
import { apiFetch } from "../api/client";
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

/** LATCH1件。相手の回答待ちなどで定期再取得したいときrefetchIntervalを渡す */
export const useLatchQuery = (
	id: string,
	options?: { refetchInterval?: number | false },
) =>
	useQuery({
		queryKey: latchQueryKey(id),
		queryFn: () => apiFetch<LatchDTO>(`/latches/${id}`),
		refetchOnWindowFocus: true,
		refetchInterval: options?.refetchInterval ?? false,
	});

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
