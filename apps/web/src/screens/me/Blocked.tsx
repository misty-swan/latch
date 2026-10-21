/**
 * ブロックしたユーザー(/settings/blocked・F7c設計 §1.6)。
 * prototype/app/app.jsのscreens.settings(blocked分岐)の移植。
 */

import { useState } from "react";
import { Link } from "react-router";
import { formatMd } from "../../latches/format";
import { useBlocksQuery, useUnblock } from "../../me/queries";
import { PATHS } from "../../routes/paths";
import { Avatar } from "../latch/art";
import { ScreenGrain } from "../shared";
import "./me.css";

const FAILED = "送れませんでした。時間をおいて、もう一度お試しください。";

export function Blocked() {
	const blocks = useBlocksQuery();
	const unblock = useUnblock();
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const [failed, setFailed] = useState(false);

	const release = async (userId: string): Promise<void> => {
		if (pending.has(userId)) return;
		setFailed(false);
		setPending((s) => new Set(s).add(userId));
		try {
			await unblock.mutateAsync(userId);
		} catch {
			setFailed(true);
		} finally {
			setPending((s) => {
				const next = new Set(s);
				next.delete(userId);
				return next;
			});
		}
	};

	const items = blocks.data;
	return (
		<div className="screen settings">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.me} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<div className="topbar__title">ブロックしたユーザー</div>
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body" style={{ paddingTop: 8 }}>
				{items !== undefined && items.length === 0 && (
					<p className="t-caption pad">ブロックしたユーザーはいません。</p>
				)}
				{items !== undefined && items.length > 0 && (
					<div className="list">
						{items.map((b) => (
							<div
								className="list-row"
								style={{ cursor: "default" }}
								key={b.user_id}
							>
								<Avatar
									userId={b.user_id}
									hasIcon={b.has_icon}
									size="m"
									tone="b"
								/>
								<span className="stack">
									<span>{b.display_name}</span>
									<span className="list-row__sub">
										{formatMd(new Date(b.created_at).getTime())}にブロック
									</span>
								</span>
								<button
									className="btn btn--secondary btn--small"
									type="button"
									disabled={pending.has(b.user_id)}
									onClick={() => void release(b.user_id)}
								>
									解除
								</button>
							</div>
						))}
					</div>
				)}
				{failed && (
					<p className="note pad" role="alert" style={{ marginTop: 12 }}>
						{FAILED}
					</p>
				)}
				<p className="t-caption pad" style={{ marginTop: 16 }}>
					解除すると、また提案が届くことがあります。以前に提案された相手との提案は、解除後も届きません。
				</p>
			</div>
		</div>
	);
}
