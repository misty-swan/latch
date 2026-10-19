/**
 * 読み解けない画面(ボード: ParseFailed.dc.htmlの移植)。
 * - parseに失敗したときの案内。文章はcomposeStateに残っている(Readingは失敗時に破棄しないため)
 * - 「もう一度読み解く」はcomposeへ戻る(文章保持・読み直しはcomposeの「読み解く」から・F2'計画どおり)
 * - 「自分で入力する」はcomposeStateを空の構造化値に置き換えてconfirmへ進む(手入力モード)
 */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
	readComposeState,
	readPendingCompose,
	saveComposeState,
} from "../intents/composeState";
import { EMPTY_PARSE } from "../intents/submit";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

export function ParseFailed() {
	const navigate = useNavigate();
	// 表示する文章は初回マウント時の状態で確定させる(parse前後どちらの状態でも読める)
	const [words] = useState(
		() =>
			readComposeState()?.raw_text ?? readPendingCompose()?.raw_text ?? null,
	);

	useEffect(() => {
		if (words === null) {
			// 入力が無い直アクセスはcomposeへ送り返す
			navigate(PATHS.compose, { replace: true });
		}
	}, [navigate, words]);

	/** composeへ戻る。文章はcomposeStateに残っているため保持される */
	const onRetry = (): void => {
		navigate(PATHS.compose);
	};

	/** 空の構造化値に置き換えてconfirmへ(confirmは通常どおり編集・保存できる) */
	const onManual = (): void => {
		const pending = readComposeState() ?? readPendingCompose();
		if (pending === null) {
			return;
		}
		saveComposeState({
			raw_text: pending.raw_text,
			draft_id: pending.draft_id,
			parse: EMPTY_PARSE,
		});
		navigate(PATHS.confirm);
	};

	return (
		<div className="screen">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.compose} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end" />
			</header>
			<div
				className="screen__body pad"
				style={{
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					paddingBottom: 24,
				}}
			>
				<p className="quote clamp-2" style={{ marginBottom: 44 }}>
					{words}
				</p>
				<h1 className="t-display t-display--s">うまく読み解けませんでした。</h1>
				<p className="t-body" style={{ marginTop: 12 }}>
					通信の状態を確かめて、もう一度お試しください。条件を自分で入れて預けることもできます。
				</p>
			</div>
			<div className="screen__foot">
				<button
					type="button"
					className="btn btn--primary btn--block"
					onClick={onRetry}
				>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M19 12a7 7 0 1 1-2.2-5.1" />
						<path d="M19.2 4.6v3.6h-3.6" />
					</svg>
					もう一度読み解く
				</button>
				<button
					type="button"
					className="btn btn--secondary btn--block"
					onClick={onManual}
				>
					自分で入力する
				</button>
			</div>
		</div>
	);
}
