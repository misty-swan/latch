/**
 * 試験共通ヘルパー。
 * home(Task 6)がTanStack Query(useQuery)で一覧を取得するため・
 * ルーターだけを描く既存の試験にQueryClientProviderを被せるのに使う
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * 試験用のQueryClient。再試行なし(即エラー扱い)で・キャッシュは試験ごとに独立。
 * 変更はアプリと同じくnetworkMode "always"(オフラインでも止めずに失敗させる)
 */
export const createTestQueryClient = (): QueryClient =>
	new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 0 },
			mutations: { networkMode: "always" },
		},
	});

/** QueryClientProviderの内側で描きたい要素(RouterProviderなど)を包む */
export const withQueryClient = (ui: ReactNode): ReactNode => (
	<QueryClientProvider client={createTestQueryClient()}>
		{ui}
	</QueryClientProvider>
);
