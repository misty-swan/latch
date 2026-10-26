/**
 * PC向けの外枠(LAT-14・PC向けの画面の設計 §1・§2)。ルートの全画面を包むレイアウトのルート。
 * - 820px以下: 何も足さない(包みの要素は display: contents で、スマホの見た目と挙動はそのまま)
 * - 821px以上: 画面をスマホの見た目のまま中央の列(幅480px)に寄せる(ログイン前の画面・タブレット)
 * - 1024px以上かつログイン後: 左のナビ+中央の列(幅688px)。ようこそ画面はPCの2列で描く
 * - 1280px以上: 「預けている」の右に提案の部屋を出し、チャットの左につながりの一覧を並べる
 * 中央の列(Outlet)は常に同じ位置に置き、幅が変わっても画面の状態(書きかけの文など)を保つ
 */

import { useState } from "react";
import { matchPath, Outlet, useLocation } from "react-router";
import { signedIn } from "../auth/guard";
import { PATHS } from "../routes/paths";
import { Connections } from "../screens/chat/Connections";
import { DesktopContext } from "./context";
import { DeskNav, type DeskSection } from "./DeskNav";
import { HomeRoom } from "./HomeRoom";
import { DESK_QUERY, ROOM_QUERY, useMediaQuery, WIDE_QUERY } from "./media";

/** ログイン後でも左のナビを出さない画面(はじめる流れの途中) */
const NAVLESS: ReadonlySet<string> = new Set([
	PATHS.welcome,
	PATHS.intro,
	PATHS.signin,
	PATHS.register,
	PATHS.consent,
]);

const COMPOSE_PATHS: ReadonlySet<string> = new Set([
	PATHS.compose,
	PATHS.reading,
	PATHS.confirm,
	PATHS.parseFailed,
	PATHS.placed,
]);

/** 左のナビで現在地として示す項目 */
const sectionOf = (pathname: string): DeskSection | null => {
	if (pathname === PATHS.home || matchPath(`${PATHS.intent}/*`, pathname)) {
		return "home";
	}
	if (pathname === PATHS.connections || matchPath(PATHS.chat, pathname)) {
		return "connections";
	}
	if (pathname === PATHS.notices) return "notices";
	if (
		matchPath(`${PATHS.me}/*`, pathname) ||
		matchPath(`${PATHS.settings}/*`, pathname)
	) {
		return "me";
	}
	if (COMPOSE_PATHS.has(pathname)) return "compose";
	return null;
};

export function DesktopFrame() {
	const wide = useMediaQuery(WIDE_QUERY);
	const desk = useMediaQuery(DESK_QUERY);
	const roomWide = useMediaQuery(ROOM_QUERY);
	const { pathname } = useLocation();

	const landing = desk && pathname === PATHS.welcome;
	const nav = desk && !NAVLESS.has(pathname) && signedIn();
	const room = nav && roomWide && pathname === PATHS.home;
	const list = nav && roomWide && matchPath(PATHS.chat, pathname) !== null;
	// 右の部屋が選んだ提案(到着カードの「右に表示中」に使う)。部屋を閉じると部屋がnullに戻す
	const [roomLatchId, setRoomLatchId] = useState<string | null>(null);

	const className = [
		"desk",
		wide && !nav && !landing ? "desk--narrow" : "",
		nav ? "desk--nav" : "",
		room ? "desk--room" : "",
		list ? "desk--list" : "",
		landing ? "desk--landing" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<DesktopContext.Provider
			value={{ nav, landing, roomLatchId: room ? roomLatchId : null }}
		>
			<div className={className}>
				{nav ? <DeskNav section={sectionOf(pathname)} /> : null}
				{list ? (
					<div className="desk__list">
						<Connections />
					</div>
				) : null}
				<div className="desk__main">
					<Outlet />
				</div>
				{room ? <HomeRoom onPick={setRoomLatchId} /> : null}
			</div>
		</DesktopContext.Provider>
	);
}
