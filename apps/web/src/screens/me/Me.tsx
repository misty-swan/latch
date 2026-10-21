/**
 * 自分(/me・F7c設計)。prototype/app/app.jsのscreens.me・Me.dc.htmlの移植。
 * ヘルプ・お問い合わせと退会の行は置かない(設計書 §0.3)。
 * ログアウトはPush購読の後始末→APIでの失効→端末の破棄→キャッシュ破棄→/welcome
 */

import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { authSession } from "../../auth/session";
import { useMeQuery } from "../../me/queries";
import { disablePushQuietly } from "../../push/subscription";
import { PATHS } from "../../routes/paths";
import { Avatar } from "../latch/art";
import { ScreenGrain } from "../shared";
import "./me.css";

const Icon = ({ children }: { children: React.ReactNode }) => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		{children}
	</svg>
);

const Chev = () => (
	<svg className="ic list-row__chev" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M9.5 6l6 6-6 6" />
	</svg>
);

const Row = ({
	to,
	icon,
	label,
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
}) => (
	<Link className="list-row" to={to}>
		<Icon>{icon}</Icon>
		<span>{label}</span>
		<Chev />
	</Link>
);

const LOCK = (
	<>
		<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4" />
		<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
	</>
);
const DOC = (
	<>
		<path d="M7 3.8h7l4 4v12.4H7z" />
		<path d="M14 3.8v4h4M9.8 12.5h5.4M9.8 15.8h5.4" />
	</>
);

export function Me() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const me = useMeQuery();

	const logout = async (): Promise<void> => {
		await authSession.logout(() => disablePushQuietly());
		// 次に入る人へ前の人のデータを見せない
		queryClient.clear();
		navigate(PATHS.welcome, { replace: true });
	};

	return (
		<div className="screen me">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.home} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<div className="topbar__title">自分</div>
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body" style={{ paddingBottom: 28 }}>
				<div className="pad me__card">
					<Avatar
						userId={me.data?.id}
						hasIcon={me.data?.has_icon ?? false}
						size="l"
						tone="b"
						label="あなたのアイコン"
					/>
					<div className="stack" style={{ gap: 4, minWidth: 0 }}>
						<p className="t-title">{me.data?.display_name ?? ""}</p>
						<p className="t-words" style={{ fontSize: 15 }}>
							{me.data === undefined ? null : me.data.bio !== "" ? (
								me.data.bio
							) : (
								<span style={{ color: "var(--ink-3)" }}>
									ひとことは未設定です
								</span>
							)}
						</p>
					</div>
				</div>
				<div className="pad" style={{ marginTop: 16 }}>
					<p className="privacy">
						<Icon>{LOCK}</Icon>
						このプロフィールは、つながった相手にだけ表示されます。
					</p>
					<Link
						className="btn btn--secondary btn--small"
						style={{ marginTop: 16 }}
						to={PATHS.profile}
					>
						<Icon>
							<path d="M5 19h3.6L18.3 9.3a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L5 15.4z" />
							<path d="M13.4 7l3.6 3.6" />
						</Icon>
						プロフィールを編集
					</Link>
				</div>
				<h2 className="list__head t-label" style={{ marginTop: 20 }}>
					設定
				</h2>
				<div className="list">
					<Row
						to={PATHS.settings}
						label="通知と表示"
						icon={
							<>
								<path d="M6.5 16.5v-5.2a5.5 5.5 0 0 1 11 0v5.2l1.6 1.9H4.9z" />
								<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
							</>
						}
					/>
					<Row
						to={PATHS.blocked}
						label="ブロックしたユーザー"
						icon={
							<>
								<circle cx="12" cy="12" r="8.5" />
								<path d="M6 18L18 6" />
							</>
						}
					/>
					<Row
						to={`${PATHS.consent}?view=1`}
						label="外部送信と同意"
						icon={LOCK}
					/>
				</div>
				<h2 className="list__head t-label">そのほか</h2>
				<div className="list">
					<Row to={PATHS.terms} label="利用規約" icon={DOC} />
					<Row to={PATHS.privacy} label="プライバシーポリシー" icon={DOC} />
					<button className="list-row" type="button" onClick={logout}>
						<Icon>
							<path d="M14 4.5h4.5v15H14" />
							<path d="M10 8l-4 4 4 4M6 12h9.5" />
						</Icon>
						<span>ログアウト</span>
						<span />
					</button>
				</div>
			</div>
		</div>
	);
}
