/**
 * ルーティング(docs/04 §3.2: React Router library mode)。
 * - welcome/intro/signin・規約ページ(terms/privacy)は未認証で見られる画面・それ以外はRequireAuthで保護する
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
import { Privacy } from "./screens/legal/Privacy";
import { Terms } from "./screens/legal/Terms";
import { Blocked } from "./screens/me/Blocked";
import { Me } from "./screens/me/Me";
import { Profile } from "./screens/me/Profile";
import { Settings } from "./screens/me/Settings";
import { Notices } from "./screens/notices/Notices";
import { ParseFailed } from "./screens/ParseFailed";
import { Placed } from "./screens/Placed";
import { Reading } from "./screens/Reading";
import { Register } from "./screens/Register";
import { SignIn } from "./screens/SignIn";
import { Report } from "./screens/safety/Report";
import { Welcome } from "./screens/Welcome";

export const appRoutes = [
	{ path: "/", element: <Navigate to={PATHS.welcome} replace /> },
	{ path: PATHS.welcome, element: <Welcome /> },
	{ path: PATHS.intro, element: <Intro /> },
	{ path: PATHS.signin, element: <SignIn /> },
	// 規約ページはサインイン前から開ける(F7c設計 §1.1)
	{ path: PATHS.terms, element: <Terms /> },
	{ path: PATHS.privacy, element: <Privacy /> },
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
		path: PATHS.notices,
		element: (
			<RequireAuth>
				<Notices />
			</RequireAuth>
		),
	},
	{
		path: PATHS.settings,
		element: (
			<RequireAuth>
				<Settings />
			</RequireAuth>
		),
	},
	{
		path: PATHS.blocked,
		element: (
			<RequireAuth>
				<Blocked />
			</RequireAuth>
		),
	},
	{
		path: PATHS.me,
		element: (
			<RequireAuth>
				<Me />
			</RequireAuth>
		),
	},
	{
		path: PATHS.profile,
		element: (
			<RequireAuth>
				<Profile />
			</RequireAuth>
		),
	},
	{
		path: PATHS.report,
		element: (
			<RequireAuth>
				<Report />
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
