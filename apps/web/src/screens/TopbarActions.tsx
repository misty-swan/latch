/**
 * 上部バー右上の入口(お知らせのベルと自分)。prototype/app/app.jsのtopRightの移植。
 * 未読があるときはラベルに件数を入れ・点を出す。
 */

import { Link } from "react-router";
import { useMeQuery } from "../me/queries";
import { useUnreadCount } from "../notices/queries";
import { PATHS } from "../routes/paths";
import { Avatar } from "./latch/art";

export function TopbarActions() {
	const unread = useUnreadCount();
	const me = useMeQuery();
	return (
		<>
			<Link
				className="icon-btn"
				to={PATHS.notices}
				aria-label={unread > 0 ? `お知らせ(未読${unread}件)` : "お知らせ"}
			>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M6.5 16.5v-5.2a5.5 5.5 0 0 1 11 0v5.2l1.6 1.9H4.9z" />
					<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
				</svg>
				{unread > 0 ? <span className="dot" /> : null}
			</Link>
			<Link className="icon-btn" to={PATHS.me} aria-label="自分">
				<Avatar
					userId={me.data?.id}
					hasIcon={me.data?.has_icon ?? false}
					size="s"
					tone="b"
					version={me.dataUpdatedAt}
				/>
			</Link>
		</>
	);
}
