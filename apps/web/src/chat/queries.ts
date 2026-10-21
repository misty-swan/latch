/**
 * つながり一覧・チャット履歴・送信・既読・離脱の取得と送信(TanStack Query)。
 * docs/05 §3.4(/v1/latches・メッセージ・既読・ws-ticket)。
 * メッセージIDはULIDなので・文字列比較が時系列順になる。
 */

import type { LatchDTO, MessageDTO, MessagePage, UserDTO } from "@latch/shared";
import {
	type InfiniteData,
	type QueryClient,
	replaceEqualDeep,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { apiFetch } from "../api/client";
import {
	LATCHES_QUERY_KEY,
	type LatchListResponse,
	latchQueryKey,
	shouldRetry,
} from "../latches/queries";

/** つながり一覧(LATCHES_QUERY_KEY配下なので既存の無効化で取り直される) */
export const CONNECTIONS_QUERY_KEY = ["latches", "connections"] as const;
/** 履歴は別系統(LATCHの無効化で履歴まで取り直さない) */
export const messagesQueryKey = (id: string) => ["messages", id] as const;
export const ME_QUERY_KEY = ["me"] as const;

type MessagesData = InfiniteData<MessagePage, string | undefined>;

/** 自分のユーザー情報(自分の発言かの判定に使う) */
export const useMeQuery = () =>
	useQuery({
		queryKey: ME_QUERY_KEY,
		queryFn: () => apiFetch<UserDTO>("/users/me"),
		staleTime: Number.POSITIVE_INFINITY,
	});

/** 成立したつながりの一覧(50件ずつ) */
export const useConnectionsQuery = () =>
	useInfiniteQuery({
		queryKey: CONNECTIONS_QUERY_KEY,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			apiFetch<LatchListResponse>(
				`/latches?type=matched&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
			),
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});

const messagesPath = (id: string, before?: string) =>
	`/latches/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`;

/**
 * 取得結果をキャッシュへ置くとき・取得中に足された(取得結果より新しい)メッセージを
 * pages[0]の末尾へ残す。取得の応答が受信・送信の成功より古い一覧で上書きして消すのを防ぐ
 */
export const keepAppended = (
	prev: MessagesData | undefined,
	next: MessagesData,
): MessagesData => {
	const [first, ...rest] = next.pages;
	if (!prev || !first) return next;
	const known = new Set(next.pages.flatMap((p) => p.items.map((m) => m.id)));
	const newest = flattenMessages(next.pages).at(-1)?.id ?? "";
	const extra = flattenMessages(prev.pages).filter(
		(m) => !known.has(m.id) && m.id > newest,
	);
	if (extra.length === 0) return next;
	return {
		...next,
		pages: [{ ...first, items: [...first.items, ...extra] }, ...rest],
	};
};

/**
 * 履歴。pages[0]が最新頁で・fetchNextPageは古い頁を取る。
 * フォーカスでの全頁の取り直しはしない(画面側がフォーカス・再接続で最新頁だけを取り直す)。
 * 404・400 invalid_statusは再試行せず・すぐ振り分けへ進める
 */
export const useMessagesQuery = (id: string) => {
	const client = useQueryClient();
	const base = client.getDefaultOptions().queries?.retry;
	return useInfiniteQuery({
		queryKey: messagesQueryKey(id),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			apiFetch<MessagePage>(messagesPath(id, pageParam)),
		getNextPageParam: (last) => last.next_before ?? undefined,
		retry: (failureCount, error) => shouldRetry(base, failureCount, error),
		refetchOnWindowFocus: false,
		structuralSharing: (prev, next) =>
			replaceEqualDeep(
				prev,
				keepAppended(prev as MessagesData | undefined, next as MessagesData),
			),
	});
};

/** 全頁をID昇順に並べ・同じIDは1つにする */
export const flattenMessages = (pages: MessagePage[]): MessageDTO[] => {
	const byId = new Map<string, MessageDTO>();
	for (const p of pages) {
		for (const m of p.items) byId.set(m.id, m);
	}
	return [...byId.values()].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
};

/** どの頁にも無いIDだけをpages[0]の末尾へ足す(キャッシュが無ければ何もしない) */
export const appendMessage = (
	client: QueryClient,
	id: string,
	message: MessageDTO,
): void => {
	client.setQueryData<MessagesData>(messagesQueryKey(id), (data) => {
		if (!data || data.pages.length === 0) return data;
		if (data.pages.some((p) => p.items.some((m) => m.id === message.id))) {
			return data;
		}
		const [first, ...rest] = data.pages;
		if (!first) return data;
		return {
			...data,
			pages: [{ ...first, items: [...first.items, message] }, ...rest],
		};
	});
};

/** 最新頁を取り直して取りこぼしを埋める(古い頁は保つ) */
export const refreshLatestMessages = async (
	client: QueryClient,
	id: string,
): Promise<void> => {
	const latest = await apiFetch<MessagePage>(messagesPath(id));
	for (const m of latest.items) appendMessage(client, id, m);
};

export const postMessage = (
	id: string,
	body: string,
	clientId: string,
): Promise<MessageDTO> =>
	apiFetch<MessageDTO>(`/latches/${id}/messages`, {
		method: "POST",
		json: { body, client_id: clientId },
	});

export const newClientId = (): string => crypto.randomUUID();

/** 既読を進める。直前に送ったIDと同じなら送らず・失敗は握りつぶす */
export const useMarkRead = (id: string): ((messageId: string) => void) => {
	const last = useRef<string | null>(null);
	return useCallback(
		(messageId: string) => {
			if (last.current === messageId) return;
			last.current = messageId;
			apiFetch<void>(`/latches/${id}/read`, {
				method: "POST",
				json: { last_read_message_id: messageId },
			}).catch(() => {});
		},
		[id],
	);
};

export const requestWsTicket = async (id: string): Promise<string> => {
	const res = await apiFetch<{ ticket: string; expires_in: number }>(
		"/ws-ticket",
		{ method: "POST", json: { scope: "chat", latch_id: id } },
	);
	return res.ticket;
};

/** 続いているLATCHから抜ける */
export const useLeaveMutation = (id: string) => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () =>
			apiFetch<LatchDTO>(`/latches/${id}/leave`, { method: "POST" }),
		onSuccess: (data) => {
			if (data.status === "cancelled") {
				client.setQueryData(latchQueryKey(id), data);
			} else {
				// 本人だけが抜けた: 以後このLATCHは読めない(404)ので・取り直さず捨ててから一覧だけ無効化する
				client.removeQueries({ queryKey: latchQueryKey(id) });
				client.removeQueries({ queryKey: messagesQueryKey(id) });
			}
			void client.invalidateQueries({ queryKey: LATCHES_QUERY_KEY });
		},
	});
};

/** 自分の表示から隠す(204) */
export const useHideMutation = (id: string) => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () => apiFetch<void>(`/latches/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			client.removeQueries({ queryKey: latchQueryKey(id) });
			client.removeQueries({ queryKey: messagesQueryKey(id) });
			void client.invalidateQueries({ queryKey: LATCHES_QUERY_KEY });
		},
	});
};
