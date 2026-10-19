/**
 * Intent一覧の取得(TanStack Query)。docs/05 §3.3(GET /v1/intents)。
 * - 自Intentのみ・id降順(ULID=新着順)で返る
 * - F2'では先頭ページ(limit=50)のみを使い・次ページの読み込みは行わない
 * - 状態の表示名対照(docs/01 §10)もここに置く(home一覧と以後の画面で共有)
 */

import type { IntentDTO, IntentStatus } from "@latch/shared";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

/** GET /v1/intentsの応答(docs/05 §3.3) */
export type IntentListResponse = {
	items: IntentDTO[];
	next_cursor: string | null;
};

/** 一覧キャッシュのキー(預け入れ・下書き更新のあとに無効化して再取得する) */
export const INTENTS_QUERY_KEY = ["intents"] as const;

/** 一覧を1ページ取得する(docs/05 §3.3・limit=1..50) */
export const fetchIntents = (): Promise<IntentListResponse> =>
	apiFetch<IntentListResponse>("/intents?limit=50");

/** 預けている一覧のhooks(home画面から使う) */
export const useIntentsQuery = () =>
	useQuery({
		queryKey: INTENTS_QUERY_KEY,
		queryFn: fetchIntents,
	});

/**
 * 状態の表示名対照(docs/01 §10)。
 * proposed/partial_accept/completedは提案以降(F4以降)のデータでのみ
 * 発生するが・対照として先に置く(表示名対照だけ実装)
 */
export const INTENT_STATUS_LABELS: Record<
	IntentStatus | "proposed" | "partial_accept" | "completed",
	string
> = {
	draft: "下書き",
	active: "預けている",
	paused: "一時停止中",
	expired: "期限切れ",
	cancelled: "取り下げ",
	proposed: "回答を待っています",
	partial_accept: "相手の回答待ち",
	matched: "つながった",
	completed: "終了",
};
