/**
 * ルーティング(docs/04 §3.2: React Router library mode)。
 * - welcome/intro/signin・IdPの戻り先(auth/callback)・規約ページ(terms/privacy)・ヘルプ(help)は未認証で見られる画面・それ以外はRequireAuthで保護する
 *   (未認証のまま入った場合はwelcomeへ送り返す)
 * - "/"は起動の入口(StartRoute)。どの道順にも当たらないURL(古いstart_urlの/index.htmlなど)は"/"へ送る(LAT-115)
 * - 全画面をPC向けの外枠(DesktopFrame)で包む(LAT-14)
 * ルート定義はappRoutesとして出し・単体試験はcreateMemoryRouter(appRoutes)で使う
 */

import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth, StartRoute } from "./auth/guard";
import { DesktopFrame } from "./desktop/DesktopFrame";
import { PATHS } from "./routes/paths";
import { Compose } from "./screens/Compose";
import { Confirm } from "./screens/Confirm";
import { Consent } from "./screens/Consent";
import { Chat } from "./screens/chat/Chat";
import { Connections } from "./screens/chat/Connections";
import { Home } from "./screens/Home";
import { IdpCallback } from "./screens/IdpCallback";
import { Intro } from "./screens/Intro";
import { IntentDetail } from "./screens/intent/IntentDetail";
import { IntentEdit } from "./screens/intent/IntentEdit";
import { LatchScreen } from "./screens/latch/LatchScreen";
import { ShelvedScreen } from "./screens/latch/ShelvedScreen";
import { Help } from "./screens/legal/Help";
import { Privacy } from "./screens/legal/Privacy";
import { Terms } from "./screens/legal/Terms";
import { Blocked } from "./screens/me/Blocked";
import { Me } from "./screens/me/Me";
import { Profile } from "./screens/me/Profile";
import { Settings } from "./screens/me/Settings";
import { Withdraw } from "./screens/me/Withdraw";
import { Notices } from "./screens/notices/Notices";
import { ParseFailed } from "./screens/ParseFailed";
import { Placed } from "./screens/Placed";
import { Reading } from "./screens/Reading";
import { Register } from "./screens/Register";
import { SignIn } from "./screens/SignIn";
import { Report } from "./screens/safety/Report";
import { Welcome } from "./screens/Welcome";

const screenRoutes = [
	{ path: "/", element: <StartRoute /> },
	{ path: PATHS.welcome, element: <Welcome /> },
	{ path: PATHS.intro, element: <Intro /> },
	{ path: PATHS.signin, element: <SignIn /> },
	// 本番IdPからの戻り先。目的(サインイン・退会)はこの画面が出発の控えで分ける(docs/04 §4)
	{ path: PATHS.idpCallback, element: <IdpCallback /> },
	// 規約ページはサインイン前から開ける(F7c設計 §1.1)
	{ path: PATHS.terms, element: <Terms /> },
	{ path: PATHS.privacy, element: <Privacy /> },
	// ヘルプも規約と同じくサインイン前から開ける(LAT-94)
	{ path: PATHS.help, element: <Help /> },
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
		path: PATHS.intent,
		element: (
			<RequireAuth>
				<IntentDetail />
			</RequireAuth>
		),
	},
	{
		path: PATHS.intentEdit,
		element: (
			<RequireAuth>
				<IntentEdit />
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
		path: PATHS.withdraw,
		element: (
			<RequireAuth>
				<Withdraw />
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
	{ path: "*", element: <Navigate to="/" replace /> },
];

// 全画面をPC向けの外枠で包む(スマホの幅では何も足さない・LAT-14)
export const appRoutes = [
	{ element: <DesktopFrame />, children: screenRoutes },
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
