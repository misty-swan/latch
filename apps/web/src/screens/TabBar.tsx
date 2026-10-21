/** 下部タブ(預けている・置く・つながり)。HomeとConnectionsで共有する */

import { Link } from "react-router";
import { PATHS } from "../routes/paths";

export function TabBar({ current }: { current: "home" | "connections" }) {
	return (
		<nav className="tabbar" aria-label="メイン">
			<Link
				className="tab"
				to={PATHS.home}
				aria-current={current === "home" ? "page" : undefined}
			>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M11.2 3.8a8.2 8.2 0 0 0 0 16.4z" fill="currentColor" />
					<path d="M13.2 3.9a8.2 8.2 0 0 1 0 16.2" strokeDasharray="2.2 2.4" />
				</svg>
				<span>預けている</span>
			</Link>
			<Link className="tab__put" to={PATHS.compose}>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 5.5v13M5.5 12h13" />
				</svg>
				<span>置く</span>
			</Link>
			<Link
				className="tab"
				to={PATHS.connections}
				aria-current={current === "connections" ? "page" : undefined}
			>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="8.2" />
					<path d="M12 3.8v16.4" />
				</svg>
				<span>つながり</span>
			</Link>
		</nav>
	);
}
