/**
 * ルーティング(docs/04 §3.2: React Router library mode)。
 * - welcome/intro/signinは未認証で見られる画面・それ以外はRequireAuthで保護する
 *   (未認証のまま入った場合はwelcomeへ送り返す)
 * - compose/reading/confirm/parse-failed/placedはTask 4〜5・homeはTask 6で差し替えるため
 *   それまでの間はパス確認用のプレースホルダを置く
 * ルート定義はappRoutesとして出し・単体試験はcreateMemoryRouter(appRoutes)で使う
 */

import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth } from "./auth/guard";
import { PATHS } from "./routes/paths";
import { Compose } from "./screens/Compose";
import { Confirm } from "./screens/Confirm";
import { Consent } from "./screens/Consent";
import { Intro } from "./screens/Intro";
import { ParseFailed } from "./screens/ParseFailed";
import { Placed } from "./screens/Placed";
import { Reading } from "./screens/Reading";
import { Register } from "./screens/Register";
import { SignIn } from "./screens/SignIn";
import { Welcome } from "./screens/Welcome";

/** 画面が差し込まれるまでの仮要素(Task 6で差し替え) */
const Placeholder = ({ screen }: { screen: string }) => (
	<p data-screen={screen}>{screen}</p>
);

export const appRoutes = [
	{ path: "/", element: <Navigate to={PATHS.welcome} replace /> },
	{ path: PATHS.welcome, element: <Welcome /> },
	{ path: PATHS.intro, element: <Intro /> },
	{ path: PATHS.signin, element: <SignIn /> },
	{
		path: PATHS.register,
		element: (
			<RequireAuth>
				<Register />
			</RequireAuth>
		),
	},
	{
		path: PATHS.consent,
		element: (
			<RequireAuth>
				<Consent />
			</RequireAuth>
		),
	},
	{
		path: PATHS.compose,
		element: (
			<RequireAuth>
				<Compose />
			</RequireAuth>
		),
	},
	{
		path: PATHS.reading,
		element: (
			<RequireAuth>
				<Reading />
			</RequireAuth>
		),
	},
	{
		path: PATHS.confirm,
		element: (
			<RequireAuth>
				<Confirm />
			</RequireAuth>
		),
	},
	{
		path: PATHS.parseFailed,
		element: (
			<RequireAuth>
				<ParseFailed />
			</RequireAuth>
		),
	},
	{
		path: PATHS.placed,
		element: (
			<RequireAuth>
				<Placed />
			</RequireAuth>
		),
	},
	{
		path: PATHS.home,
		element: (
			<RequireAuth>
				<Placeholder screen="home" />
			</RequireAuth>
		),
	},
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
