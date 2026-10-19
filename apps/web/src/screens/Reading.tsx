/**
 * 読み解き中画面(ボード: Reading.dc.htmlの移植)。
 * - Composeが置いた入力(composeState・sessionStorage経由)をPOST /v1/intents/parseへかける
 *   (画面遷移してからparseする=ボードの画面フローどおり)
 * - 成功→parse結果をcomposeStateへ保存してconfirmへ。
 *   失敗(422 PARSE_FAILED・通信断・その他のエラー)→parse-failedへ遷移する
 *   (遷移先の画面自体はTask 5で組む)
 * - parse済みの状態では再parseせずconfirmへ・入力が無い直アクセスではcomposeへ送り返す
 *   (確認画面がリロード・直アクセスで壊れないようにする: F2'計画Review Focus #3)
 */

import type { ParseIntentResponse } from "@latch/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { apiFetch } from "../api/client";
import {
	readComposeState,
	readPendingCompose,
	saveComposeState,
} from "../intents/composeState";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

export function Reading() {
	const navigate = useNavigate();
	// 表示する文章は初回マウント時の入力で確定させる(parse待ちの間もボードどおり表示する)
	const [words] = useState(() => {
		const done = readComposeState();
		if (done !== null) {
			return done.raw_text;
		}
		return readPendingCompose()?.raw_text ?? "";
	});

	useEffect(() => {
		// parse済み(確認からの行き返し・リロード)なら再parseしない
		if (readComposeState() !== null) {
			navigate(PATHS.confirm, { replace: true });
			return;
		}
		const pending = readPendingCompose();
		if (pending === null) {
			// 入力が無い直アクセス・入力欄へ送り返す
			navigate(PATHS.compose, { replace: true });
			return;
		}
		let cancelled = false;
		apiFetch<ParseIntentResponse>("/intents/parse", {
			method: "POST",
			json: { raw_text: pending.raw_text },
		})
			.then((parse) => {
				if (cancelled) {
					return;
				}
				saveComposeState({
					raw_text: pending.raw_text,
					draft_id: pending.draft_id,
					parse,
				});
				navigate(PATHS.confirm, { replace: true });
			})
			.catch(() => {
				// 422 PARSE_FAILEDをはじめ読み解けなかった場合はparse-failedへ
				if (!cancelled) {
					navigate(PATHS.parseFailed, { replace: true });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [navigate]);

	return (
		<div className="screen reading">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.compose} aria-label="やめる">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
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
					paddingBottom: 96,
				}}
			>
				<p
					className="t-words reading__text"
					style={{ fontSize: 21, lineHeight: 1.9 }}
				>
					{words}
				</p>
				<p className="row t-label" style={{ gap: 12, marginTop: 36 }}>
					読み解いています
					<span className="reading-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
				</p>
				<p className="t-caption" style={{ marginTop: 4 }}>
					主題と、日時・場所などの条件を読み取っています。
				</p>
			</div>
		</div>
	);
}
