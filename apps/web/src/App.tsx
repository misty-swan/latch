/**
 * アプリ本体。ThemeProvider→QueryClientProvider→AuthGate→RouterProviderの順に組てる(docs/04 §3.2)。
 * AuthGateは起動時のセッション復元(restore)が完了してからルーターを描画する
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { AuthGate } from "./auth/startup";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme";

const queryClient = new QueryClient();

/** アプリ標準のルーター(起動時に1回だけ生成する。試験では差し替え可能) */
const defaultRouter = createAppRouter();

export type AppRouter = typeof defaultRouter;

export function App({ router = defaultRouter }: { router?: AppRouter }) {
	return (
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<AuthGate>
					<RouterProvider router={router} />
				</AuthGate>
			</QueryClientProvider>
		</ThemeProvider>
	);
}
