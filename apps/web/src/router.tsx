/**
 * ルーティング(docs/04 §3.2: React Router library mode)。
 * - welcome/intro/signinは未認証で見られる画面・それ以外はRequireAuthで保護する
 *   (未認証のまま入った場合はwelcomeへ送り返す)
 * ルート定義はappRoutesとして出し・単体試験はcreateMemoryRouter(appRoutes)で使う
 */

import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth } from "./auth/guard";
import { PATHS } from "./routes/paths";
import { Compose } from "./screens/Compose";
import { Confirm } from "./screens/Confirm";
import { Consent } from "./screens/Consent";
import { Chat } from "./screens/chat/Chat";
import { Connections } from "./screens/chat/Connections";
import { Home } from "./screens/Home";
import { Intro } from "./screens/Intro";
import { LatchScreen } from "./screens/latch/LatchScreen";
import { ShelvedScreen } from "./screens/latch/ShelvedScreen";
import { ParseFailed } from "./screens/ParseFailed";
import { Placed } from "./screens/Placed";
import { Reading } from "./screens/Reading";
import { Register } from "./screens/Register";
import { SignIn } from "./screens/SignIn";
import { Welcome } from "./screens/Welcome";

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
				<Home />
			</RequireAuth>
		),
	},
	{
		path: PATHS.latch,
		element: (
			<RequireAuth>
				<LatchScreen />
			</RequireAuth>
		),
	},
	{
		path: PATHS.latchShelved,
		element: (
			<RequireAuth>
				<ShelvedScreen />
			</RequireAuth>
		),
	},
	{
		path: PATHS.connections,
		element: (
			<RequireAuth>
				<Connections />
			</RequireAuth>
		),
	},
	{
		path: PATHS.chat,
		element: (
			<RequireAuth>
				<Chat />
			</RequireAuth>
		),
	},
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
