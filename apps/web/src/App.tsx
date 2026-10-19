/**
 * アプリ本体。ThemeProvider→QueryClientProvider→RouterProviderの順に組てる(docs/04 §3.2)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { ThemeProvider } from "./theme";

const queryClient = new QueryClient();

export function App() {
	return (
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</ThemeProvider>
	);
}
