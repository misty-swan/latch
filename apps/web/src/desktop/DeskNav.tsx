/**
 * PCの左のナビ(prototype/project/Desktop.dc.html の nav・LAT-14)。
 * スマホの下部タブ(TabBar)と右上の入口(TopbarActions)の役目をまとめて持つ。
 * お知らせのラベルは右上のベルと同じ(未読があれば件数を入れ・点を出す)
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMeQuery } from "../me/queries";
import { useUnreadCount } from "../notices/queries";
import { PATHS } from "../routes/paths";
import { Avatar } from "../screens/latch/art";
import { ScreenGrain } from "../screens/shared";

export type DeskSection = "home" | "connections" | "notices" | "me" | "compose";

function NavLink({
	to,
	current,
	label,
	children,
}: {
	to: string;
	current: boolean;
	label?: string;
	children: ReactNode;
}) {
	return (
		<Link
			className="desk-nav__link"
			to={to}
			aria-current={current ? "page" : undefined}
			aria-label={label}
		>
			{children}
		</Link>
	);
}

export function DeskNav({ section }: { section: DeskSection | null }) {
	const unread = useUnreadCount();
	const me = useMeQuery();
	return (
		<nav className="screen desk-nav" aria-label="メイン">
			<ScreenGrain />
			<Link
				className="brand"
				to={PATHS.home}
				aria-label="LATCH 預けている一覧へ"
			>
				<svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
					<path className="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z" />
					<path className="mark__theirs" d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z" />
				</svg>
				<span className="brand__word">LATCH</span>
			</Link>
			<Link
				className="tab__put desk-nav__put"
				to={PATHS.compose}
				aria-current={section === "compose" ? "page" : undefined}
			>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 5.5v13M5.5 12h13" />
				</svg>
				<span>ひとこと置く</span>
			</Link>
			<div className="desk-nav__links">
				<NavLink to={PATHS.home} current={section === "home"}>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M11.2 3.8a8.2 8.2 0 0 0 0 16.4z" fill="currentColor" />
						<path
							d="M13.2 3.9a8.2 8.2 0 0 1 0 16.2"
							strokeDasharray="2.2 2.4"
						/>
					</svg>
					預けている
				</NavLink>
				<NavLink to={PATHS.connections} current={section === "connections"}>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.2" />
						<path d="M12 3.8v16.4" />
					</svg>
					つながり
				</NavLink>
				<NavLink
					to={PATHS.notices}
					current={section === "notices"}
					label={unread > 0 ? `お知らせ(未読${unread}件)` : undefined}
				>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M6.5 16.5v-5.2a5.5 5.5 0 0 1 11 0v5.2l1.6 1.9H4.9z" />
						<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
					</svg>
					お知らせ
					{unread > 0 ? <span className="desk-nav__dot" /> : null}
				</NavLink>
			</div>
			<span className="desk-nav__spacer" />
			<Link
				className="desk-nav__me"
				to={PATHS.me}
				aria-current={section === "me" ? "page" : undefined}
			>
				<Avatar
					userId={me.data?.id}
					hasIcon={me.data?.has_icon ?? false}
					size="m"
					tone="b"
					version={me.dataUpdatedAt}
				/>
				<span className="stack" style={{ minWidth: 0 }}>
					<span className="desk-nav__name">
						{me.data?.display_name ?? "自分"}
					</span>
					<span className="t-meta">自分・設定</span>
				</span>
			</Link>
		</nav>
	);
}
