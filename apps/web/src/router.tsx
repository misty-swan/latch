/**
 * ルーティング(docs/04 §3.2: React Router library mode)。
 * 各画面コンポーネントはTask 3〜6で差し込む。それまでの間はパス確認用のプレースホルダを置く
 */

import { createBrowserRouter, Navigate } from "react-router";
import { PATHS } from "./routes/paths";

/** 画面が差し込まれるまでの仮要素 */
const Placeholder = ({ screen }: { screen: string }) => (
	<p data-screen={screen}>{screen}</p>
);

export const router = createBrowserRouter([
	{ path: "/", element: <Navigate to={PATHS.welcome} replace /> },
	{ path: PATHS.welcome, element: <Placeholder screen="welcome" /> },
	{ path: PATHS.intro, element: <Placeholder screen="intro" /> },
	{ path: PATHS.signin, element: <Placeholder screen="signin" /> },
	{ path: PATHS.register, element: <Placeholder screen="register" /> },
	{ path: PATHS.consent, element: <Placeholder screen="consent" /> },
	{ path: PATHS.compose, element: <Placeholder screen="compose" /> },
	{ path: PATHS.reading, element: <Placeholder screen="reading" /> },
	{ path: PATHS.confirm, element: <Placeholder screen="confirm" /> },
	{ path: PATHS.parseFailed, element: <Placeholder screen="parse-failed" /> },
	{ path: PATHS.placed, element: <Placeholder screen="placed" /> },
	{ path: PATHS.home, element: <Placeholder screen="home" /> },
]);
