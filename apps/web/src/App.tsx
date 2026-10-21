/**
 * アプリ本体。ThemeProvider→PersistQueryClientProvider→AuthGate→RouterProviderの順に組てる(docs/04 §3.2)。
 * AuthGateは起動時のセッション復元(restore)が完了してからルーターを描画する。
 * 取得結果の一部(4つのキー)は利用者IDに紐づけて端末に保存し、オフライン中の表示に使う(F8a設計 §2.1)
 */

import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "react-router";
import { authSession } from "./auth/session";
import { AuthGate } from "./auth/startup";
import {
	clearOfflineCache,
	createOfflinePersister,
	OFFLINE_MAX_AGE_MS,
	shouldPersistQuery,
} from "./offline/persister";
import { startReconnect } from "./offline/reconnect";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme";

const queryClient = new QueryClient();

const persistOptions = {
	persister: createOfflinePersister(() => authSession.userId),
	maxAge: OFFLINE_MAX_AGE_MS,
	dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
};

// モジュール読み込み時に1回だけ登録する。セッションの破棄(ログアウト・ログインの拒否)と
// 別の利用者でのサインインでメモリと端末の保存を消し、接続の回復で復元をやり直す
const stopClearListener = authSession.onClear(() => {
	void clearOfflineCache(queryClient);
});
const stopUserChangeListener = authSession.onUserChange(() => {
	void clearOfflineCache(queryClient);
});
const stopReconnect = startReconnect(queryClient);
// 開発時の差し替え(HMR)でモジュールが読み直されたときに二重に登録しない
import.meta.hot?.dispose(() => {
	stopClearListener();
	stopUserChangeListener();
	stopReconnect();
});

/** アプリ標準のルーター(起動時に1回だけ生成する。試験では差し替え可能) */
const defaultRouter = createAppRouter();

export type AppRouter = typeof defaultRouter;

export function App({ router = defaultRouter }: { router?: AppRouter }) {
	return (
		<ThemeProvider>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={persistOptions}
			>
				<AuthGate>
					<RouterProvider router={router} />
				</AuthGate>
			</PersistQueryClientProvider>
		</ThemeProvider>
	);
}
