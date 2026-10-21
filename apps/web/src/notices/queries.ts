/**
 * アプリ内通知(お知らせ)の取得と既読(TanStack Query)。
 * docs/05(GET /v1/notifications・POST /v1/notifications/read)。
 */

import type { NotificationListResponse } from "@latch/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

/** 一覧(無効化はこの配下をまとめて取り直す) */
export const NOTICES_QUERY_KEY = ["notifications"] as const;
/** 未読件数だけを持つ軽い取得(右上のベル用) */
export const UNREAD_QUERY_KEY = ["notifications", "unread"] as const;

const noticesPath = (cursor?: string) =>
	`/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;

/** お知らせ一覧(20件ずつ) */
export const useNoticesQuery = () =>
	useInfiniteQuery({
		queryKey: NOTICES_QUERY_KEY,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			apiFetch<NotificationListResponse>(noticesPath(pageParam)),
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});

/** 未読件数(1頁目のunread_count)。60秒ごと・画面復帰時に取り直す。取得前・失敗時は0 */
export const useUnreadCount = (): number => {
	const { data } = useQuery({
		queryKey: UNREAD_QUERY_KEY,
		queryFn: () => apiFetch<NotificationListResponse>(noticesPath()),
		select: (res) => res.unread_count,
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
	});
	return data ?? 0;
};

/** 表示した先頭のIDまでを既読にする(204) */
export const markNoticesRead = (upToId: string): Promise<void> =>
	apiFetch<void>("/notifications/read", {
		method: "POST",
		json: { up_to_id: upToId },
	});
