/** 自分のユーザー情報の取得(TanStack Query)。docs/05 §2.5(GET /v1/users/me) */

import type { UserDTO } from "@latch/shared";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

export const ME_QUERY_KEY = ["me"] as const;

/** 自分のユーザー情報(自分の発言かの判定・右上のアイコンに使う) */
export const useMeQuery = () =>
	useQuery({
		queryKey: ME_QUERY_KEY,
		queryFn: () => apiFetch<UserDTO>("/users/me"),
		staleTime: Number.POSITIVE_INFINITY,
	});
