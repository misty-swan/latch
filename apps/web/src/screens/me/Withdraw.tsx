/**
 * 退会(/me/withdraw)。prototype/app/app.jsのscreens.withdraw・Withdraw.dc.htmlの移植。
 * - 確認の段はこの画面そのもの(削除されるもの・相手の側に残るもの・再認証の予告)。
 *   [Googleで確かめて退会する]でIdPの再認証を行い、得たトークンでDELETE /v1/users/meを呼ぶ(docs/05 §3.2)
 * - 本番IdP SDKはF10で接続する。開発/ステージング(import.meta.env.DEV・VITE_DEV_AUTH=1)では
 *   サインインと同じテスト用の確かめ(名前入力→POST /v1/dev/idp-token)に繋がる
 * - 成功したら端末の購読とセッション・キャッシュを捨て、はじめの画面(/welcome)へ「退会しました。」を
 *   渡す(2026-10-26オーナー決定・ログアウトと同じ流れ)
 * 文言・構造・クラス名はボードどおり。dev専用UIと失敗の表示は実装の裁量
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../api/client";
import { authSession } from "../../auth/session";
import { forgetPushOnDevice } from "../../push/subscription";
import { PATHS } from "../../routes/paths";
import { ScreenGrain } from "../shared";
import "./me.css";

/** devの確かめが有効か(SignInと同じ条件) */
const isDevSigninEnabled = (): boolean =>
	import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH === "1";

/** 退会を終えたとき、はじめの画面に出す一言 */
export const WITHDRAWN_TOAST = "退会しました。";

const FAILED = "退会できませんでした。もう一度お試しください";

const Check = () => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M5 12.5l4.6 4.6L19 7.6" />
	</svg>
);

export function Withdraw() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [devFormOpen, setDevFormOpen] = useState(false);
	const [subject, setSubject] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [prodNote, setProdNote] = useState(false);

	const start = () => {
		if (isDevSigninEnabled()) {
			setProdNote(false);
			setDevFormOpen(true);
		} else {
			// 本番IdPの再認証はF10で接続する(未実装の旨のみ示す)
			setProdNote(true);
		}
	};

	const withdraw = async (): Promise<void> => {
		const trimmed = subject.trim();
		if (trimmed === "" || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const { idp_token } = await apiFetch<{ idp_token: string }>(
				"/dev/idp-token",
				{ method: "POST", json: { subject: trimmed } },
			);
			await apiFetch<void>("/users/me", {
				method: "DELETE",
				json: { provider: "google", idp_token },
			});
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : FAILED);
			setBusy(false);
			return;
		}
		// サーバーの購読・トークンは退会の処理で消えている。端末に残るものを捨てる
		await forgetPushOnDevice();
		authSession.clear();
		queryClient.clear();
		navigate(PATHS.welcome, {
			replace: true,
			state: { toast: WITHDRAWN_TOAST },
		});
	};

	return (
		<div className="screen withdraw">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.me} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<div className="topbar__title">退会</div>
				<div className="topbar__side topbar__side--end" />
			</header>
			<div
				className="screen__body pad"
				style={{ paddingTop: 8, paddingBottom: 24 }}
			>
				<h1 className="t-display t-display--s">退会の前に。</h1>
				<p className="t-body" style={{ marginTop: 12 }}>
					退会すると、次のものが削除されます。元には戻せません。
				</p>
				<ul className="bullets" style={{ marginTop: 18 }}>
					<li>
						<Check />
						<span>預けた意思と、その読み解き結果</span>
					</li>
					<li>
						<Check />
						<span>プロフィールとアイコン</span>
					</li>
					<li>
						<Check />
						<span>提案の履歴</span>
					</li>
				</ul>
				<p className="note" style={{ marginTop: 22 }}>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.5" />
						<path d="M12 11v5.2" />
						<circle cx="12" cy="7.9" r=".9" fill="currentColor" stroke="none" />
					</svg>
					<span>
						つながりのメッセージは、相手の側に残ります。あなたの名前とアイコンは、相手の側にも表示されなくなります。
					</span>
				</p>
				<p className="t-caption" style={{ marginTop: 18 }}>
					退会の前に、もう一度ログインして本人であることを確かめます。
				</p>
				{prodNote && (
					<p className="note" style={{ marginTop: 20 }}>
						<span>Google/Appleでの確認は準備中です。</span>
					</p>
				)}
				{devFormOpen && (
					<div className="dev-signin">
						<p className="dev-signin__caption">
							開発用: テスト鍵での本人確認(docs/04 §4・本番では表示されません)
						</p>
						<label className="field__label" htmlFor="dev-withdraw-name">
							サインインに使った名前
						</label>
						<input
							className="input"
							id="dev-withdraw-name"
							maxLength={64}
							autoComplete="off"
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
						/>
						<button
							type="button"
							className="btn btn--danger btn--block"
							disabled={busy}
							onClick={withdraw}
						>
							確かめて退会する
						</button>
						{error !== null && (
							<p className="field__error" role="alert">
								{error}
							</p>
						)}
					</div>
				)}
			</div>
			<div className="screen__foot">
				<button
					className="btn btn--danger btn--block"
					type="button"
					onClick={start}
				>
					<svg className="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M19.6 12.2c0-.6-.1-1.1-.2-1.6H12v3.1h4.3a3.7 3.7 0 0 1-1.6 2.4v2h2.6c1.5-1.4 2.3-3.4 2.3-5.9z" />
						<path d="M12 20c2.2 0 4-.7 5.3-1.9l-2.6-2a4.8 4.8 0 0 1-7.2-2.5H4.8v2.1A8 8 0 0 0 12 20z" />
						<path d="M7.5 13.6a4.8 4.8 0 0 1 0-3.2V8.3H4.8a8 8 0 0 0 0 7.4z" />
						<path d="M12 7.2c1.2 0 2.3.4 3.2 1.2l2.3-2.3A8 8 0 0 0 4.8 8.3l2.7 2.1A4.8 4.8 0 0 1 12 7.2z" />
					</svg>
					Googleで確かめて退会する
				</button>
				<Link className="btn btn--quiet" to={PATHS.me}>
					やめる
				</Link>
			</div>
		</div>
	);
}
