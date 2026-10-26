/**
 * サインイン画面(ボード: SignIn.dc.html の移植)。
 * - Google/Appleのボタンは本番IdP SDK接続がスコープ外のため表示のみ(押すと未実装の旨)
 * - 開発/ステージング(import.meta.env.DEV・またはVITE_DEV_AUTH=1)では・押すと
 *   テストサインイン(名前入力→POST /v1/dev/idp-token→POST /v1/auth/token)に繋がる
 *   (docs/04 §4のテスト鍵・F2'計画Task 2のdev専用エンドポイント)
 * 文言・構造・クラス名はボードどおり。dev専用UIの細部だけ実装の裁量
 * PCの幅(1024px以上)では、ようこそと同じ2列の右の列に描く(LAT-118)
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../api/client";
import { authSession } from "../auth/session";
import { OnboardScreen } from "../desktop/OnboardScreen";
import { PATHS } from "../routes/paths";

/** POST /v1/auth/tokenの応答(docs/05 §3.2・worker/routes/auth.tsの実装に一致) */
interface AuthTokenResponse {
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
	user: unknown;
	registration_required: boolean;
}

/** devサインインが有効か(開発ビルドまたは明示的な有効化) */
const isDevSigninEnabled = (): boolean =>
	import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH === "1";

export function SignIn() {
	const navigate = useNavigate();
	const [devFormOpen, setDevFormOpen] = useState(false);
	const [subject, setSubject] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [prodNote, setProdNote] = useState(false);

	const startSignin = () => {
		if (isDevSigninEnabled()) {
			setProdNote(false);
			setDevFormOpen(true);
		} else {
			// 本番ボタンの実接続はスコープ外(未実装の旨のみ示す)
			setProdNote(true);
		}
	};

	const devSignin = async () => {
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
			const token = await apiFetch<AuthTokenResponse>("/auth/token", {
				method: "POST",
				json: { provider: "google", idp_token },
			});
			authSession.setTokens(token.access_token, token.refresh_token);
			navigate(token.registration_required ? PATHS.register : PATHS.home, {
				replace: true,
			});
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? cause.message
					: "サインインできませんでした。もう一度お試しください",
			);
			setBusy(false);
		}
	};

	return (
		<OnboardScreen label="アカウント">
			<header className="topbar">
				<div className="topbar__side">
					{/* ボードどおり戻り先はIntro3(?step=で初期ステップを指定) */}
					<Link
						className="icon-btn"
						to={`${PATHS.intro}?step=3`}
						aria-label="戻る"
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div className="screen__body pad" style={{ paddingTop: 20 }}>
				<h1 className="t-display t-display--s">
					はじめに、アカウントをつくります。
				</h1>
				<p className="t-body" style={{ marginTop: 14 }}>
					ログインには、GoogleかAppleのアカウントを使います。LATCHでパスワードを作ることはありません。
				</p>
				<div className="stack" style={{ gap: 10, marginTop: 36 }}>
					<button
						type="button"
						className="btn btn--secondary btn--block"
						onClick={startSignin}
					>
						<svg className="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M19.6 12.2c0-.6-.1-1.1-.2-1.6H12v3.1h4.3a3.7 3.7 0 0 1-1.6 2.4v2h2.6c1.5-1.4 2.3-3.4 2.3-5.9z" />
							<path d="M12 20c2.2 0 4-.7 5.3-1.9l-2.6-2a4.8 4.8 0 0 1-7.2-2.5H4.8v2.1A8 8 0 0 0 12 20z" />
							<path d="M7.5 13.6a4.8 4.8 0 0 1 0-3.2V8.3H4.8a8 8 0 0 0 0 7.4z" />
							<path d="M12 7.2c1.2 0 2.3.4 3.2 1.2l2.3-2.3A8 8 0 0 0 4.8 8.3l2.7 2.1A4.8 4.8 0 0 1 12 7.2z" />
						</svg>
						Googleで続ける
					</button>
					<button
						type="button"
						className="btn btn--secondary btn--block"
						onClick={startSignin}
					>
						<svg className="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M15.6 12.6c0-2 1.6-2.9 1.7-3a3.7 3.7 0 0 0-2.9-1.6c-1.2-.1-2.4.7-3 .7s-1.6-.7-2.6-.7a3.9 3.9 0 0 0-3.3 2c-1.4 2.5-.4 6.1 1 8.1.7 1 1.5 2 2.5 2s1.4-.6 2.6-.6 1.5.6 2.6.6 1.7-1 2.4-2a8 8 0 0 0 1.1-2.2 3.4 3.4 0 0 1-2.1-3.3z" />
							<path d="M13.8 6.4a3.4 3.4 0 0 0 .8-2.5 3.6 3.6 0 0 0-2.3 1.2 3.3 3.3 0 0 0-.8 2.4 3 3 0 0 0 2.3-1.1z" />
						</svg>
						Appleで続ける
					</button>
				</div>
				{prodNote && (
					<p className="note" style={{ marginTop: 20 }}>
						<span>Google/Appleでのサインインは準備中です。</span>
					</p>
				)}
				{devFormOpen && (
					<div className="dev-signin">
						<p className="dev-signin__caption">
							開発用: テスト鍵のサインイン(docs/04 §4・本番では表示されません)
						</p>
						<label className="field__label" htmlFor="dev-name">
							名前
						</label>
						<input
							className="input"
							id="dev-name"
							maxLength={64}
							autoComplete="off"
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
						/>
						<button
							type="button"
							className="btn btn--secondary btn--block"
							disabled={busy}
							onClick={devSignin}
						>
							テストではじめる
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
				<p className="t-caption">
					LATCHは18歳以上の方がご利用いただけます。続けると、
					<Link className="link" to={PATHS.terms}>
						利用規約
					</Link>
					と
					<Link className="link" to={PATHS.privacy}>
						プライバシーポリシー
					</Link>
					に同意したことになります。
				</p>
			</div>
		</OnboardScreen>
	);
}
