/**
 * 預けた画面(ボード: Placed.dc.htmlの移植)。
 * - 預けた文章・縦書き「預けました。」・latch is-waitingの演出
 * - 受け渡し状態(composeState)はここで消費して破棄する(次の預け入れに残さない)
 * - 数秒後の自動遷移と「預けている一覧へ」でhomeへ進む
 * - push-ask(届いたときの通知)は、この端末で通知の許可がまだ未決のときだけ出す(設計書 §3.1)。
 *   [通知を受け取る]は購読の手順を待ってから(結果を問わず)homeへ・[あとで]は何もせずhomeへ
 */

import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { clearComposeState, readComposeState } from "../intents/composeState";
import {
	browserPushEnv,
	enablePush,
	PUSH_STATUS_QUERY_KEY,
} from "../push/subscription";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

/** 演出(縦書きのink-inとrise)が収まってから自動で進む待ち時間(実装の裁量) */
const AUTO_REDIRECT_MS = 4000;

/** 縦書きの1字ずつ(--iでink-inの遅延をずらす・ボードどおり) */
const WORDS_CHARS = ["預", "け", "ま", "し", "た", "。"];

export function Placed() {
	const navigate = useNavigate();
	// 預けた文章は初回マウント時のcomposeStateで確定させる
	const [words] = useState(() => readComposeState()?.raw_text ?? null);
	const queryClient = useQueryClient();
	// 許可済み・拒否済み・非対応の端末では聞かない
	const [askPush] = useState(() => browserPushEnv.permission() === "default");
	const [enabling, setEnabling] = useState(false);

	const onEnablePush = async () => {
		setEnabling(true);
		const status = await enablePush();
		queryClient.setQueryData(PUSH_STATUS_QUERY_KEY, status);
		navigate(PATHS.home);
	};

	useEffect(() => {
		if (words === null) {
			// 状態が無い直アクセス(リロード・直接URL)は一覧へ送り返す
			navigate(PATHS.home, { replace: true });
			return;
		}
		clearComposeState();
		if (enabling) {
			// 許可の確認を出しているあいだは自動で進めない(押した後の遷移はonEnablePushが行う)
			return;
		}
		const timer = window.setTimeout(
			() => navigate(PATHS.home),
			AUTO_REDIRECT_MS,
		);
		return () => window.clearTimeout(timer);
	}, [navigate, words, enabling]);

	return (
		<div className="screen placed">
			<ScreenGrain />
			<div
				className="screen__body"
				style={{ display: "flex", flexDirection: "column" }}
			>
				<div style={{ position: "relative", height: 388, flex: "none" }}>
					<p className="placed__words t-words" aria-hidden="true">
						{words}
					</p>
					<div
						className="placed__art"
						style={{ position: "absolute", left: 28, top: 118 }}
					>
						<div
							className="latch is-waiting"
							style={{ "--size": "196px", "--gap": "18px" } as CSSProperties}
							aria-hidden="true"
						>
							<span className="latch__light" />
							<span className="latch__mine" />
							<span className="latch__theirs">
								<span className="latch__ink" />
							</span>
						</div>
					</div>
					<p
						className="tategaki reveal reveal--late"
						role="img"
						style={{
							position: "absolute",
							right: 36,
							top: 92,
							fontSize: 30,
						}}
						aria-label="預けました。"
					>
						<span aria-hidden="true">
							{WORDS_CHARS.map((char, index) => (
								<span
									key={char}
									className="ch"
									style={{ "--i": index } as CSSProperties}
								>
									{char}
								</span>
							))}
						</span>
					</p>
				</div>
				<div className="pad">
					<p className="t-title rise rise-4">あとは、待つだけ。</p>
					<p className="t-body rise rise-5" style={{ marginTop: 8 }}>
						合う相手が現れたときだけ、お知らせします。届かない日も、意思はここに置かれています。
					</p>
				</div>
				{askPush && (
					<div className="push-ask rise rise-5">
						<p className="row t-head" style={{ gap: 10 }}>
							<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M6.5 16.5v-5.2a5.5 5.5 0 0 1 11 0v5.2l1.6 1.9H4.9z" />
								<path d="M10 20.6a2.1 2.1 0 0 0 4 0" />
							</svg>
							届いたとき、通知でお知らせしましょうか。
						</p>
						<p className="t-caption" style={{ marginTop: 4 }}>
							通知には、意思の内容も相手のことも表示されません。
						</p>
						<div className="row" style={{ gap: 8, marginTop: 12 }}>
							<button
								type="button"
								className="btn btn--primary btn--small"
								disabled={enabling}
								onClick={() => void onEnablePush()}
							>
								通知を受け取る
							</button>
							<button
								type="button"
								className="btn btn--quiet btn--small"
								onClick={() => navigate(PATHS.home)}
							>
								あとで
							</button>
						</div>
					</div>
				)}
			</div>
			<div className="screen__foot">
				<Link className="btn btn--secondary btn--block" to={PATHS.home}>
					預けている一覧へ
				</Link>
			</div>
		</div>
	);
}
