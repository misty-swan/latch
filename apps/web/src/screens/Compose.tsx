/**
 * 預ける画面(ボード: Compose.dc.html・ComposeFull.dc.htmlの移植)。
 * - 便箋(textarea)に書いた文章を「読み解く」で /reading へ渡す(parseは遷移後にReadingが呼ぶ)
 * - カウンタはaria-liveで読み上げ・残り15字以内はis-near・上限でis-full
 *   (DSComponents.dc.htmlの3状態に対応)
 * - 空欄では送信不可(ボタン無効)・上限超えはmaxlength属性に加え
 *   parseと同じ@latch/sharedの検証(parseIntentRequestSchema)で止める
 * - 右上「下書きに残す」= raw_textのみでPOST /v1/intents {status:"draft"}(docs/05 §3.2)してhomeへ
 * - ?draft=<id>付きで開いた場合は下書きのraw_textを復元し・以降の保存はPATCHで下書き更新する
 *   (draft→active化はTask 5のconfirm画面が担う)
 * 文言・構造・クラス名はボードどおり。空の下書きの扱い・復元失敗時の扱い・エラー表示だけ実装の裁量
 */

import {
	type IntentDTO,
	LIMITS,
	parseIntentRequestSchema,
} from "@latch/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiError, apiFetch } from "../api/client";
import {
	readComposeState,
	readPendingCompose,
	savePendingCompose,
} from "../intents/composeState";
import { PATHS } from "../routes/paths";
import { RouteToast, useRouteToast } from "./RouteToast";
import { ScreenGrain } from "./shared";

/** カウンタがis-near(注意色)になる残り字数(DSComponents.dc.html: 285/300がis-near) */
const NEAR_REMAINING = 15;

export function Compose() {
	const navigate = useNavigate();
	const toast = useRouteToast();
	const [searchParams] = useSearchParams();
	const draftParam = searchParams.get("draft");

	// 確認からの「文章を直す」・読み解けなかった「もう一度読み解く」で
	// 文章と下書きidを保持する(composeStateに残っている分から復元: F2'計画Review Focus #3)
	const [text, setText] = useState(
		() => readComposeState()?.raw_text ?? readPendingCompose()?.raw_text ?? "",
	);
	const [draftId, setDraftId] = useState<string | null>(
		() =>
			readComposeState()?.draft_id ?? readPendingCompose()?.draft_id ?? null,
	);
	const [restoring, setRestoring] = useState(draftParam !== null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// ?draft=<id>の復元。下書き以外(active等)はraw_textをPATCHできないため
	// 新規の預ける画面として扱う(docs/05 §3.3のPATCH可変フィールド)
	useEffect(() => {
		if (draftParam === null) {
			return;
		}
		let cancelled = false;
		setRestoring(true);
		apiFetch<IntentDTO>(`/intents/${draftParam}`)
			.then((intent) => {
				if (cancelled) {
					return;
				}
				if (intent.status === "draft") {
					setDraftId(intent.id);
					setText(intent.raw_text);
				}
			})
			.catch(() => {
				// 取得できない下書き(削除済み等)も新規扱いに倒す(エラー画面には行かない)
			})
			.finally(() => {
				if (!cancelled) {
					setRestoring(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [draftParam]);

	const count = text.length;
	const counterClass =
		count >= LIMITS.RAW_TEXT_MAX_LENGTH
			? "counter is-full"
			: count >= LIMITS.RAW_TEXT_MAX_LENGTH - NEAR_REMAINING
				? "counter is-near"
				: "counter";

	const onRead = (): void => {
		// maxlength属性で入力を制限しつつ・属性を迂回した入力はparseと同じ検証で止める
		// (parseの送信可否と条件を揃える)
		if (!parseIntentRequestSchema.safeParse({ raw_text: text }).success) {
			return;
		}
		savePendingCompose({ raw_text: text, draft_id: draftId });
		navigate(PATHS.reading);
	};

	const onSaveDraft = async (): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (draftId === null) {
				if (text.trim().length === 0) {
					// 残す文章が無いため空の下書きは作らない(homeへ戻るだけ)
					navigate(PATHS.home);
					return;
				}
				await apiFetch<IntentDTO>("/intents", {
					method: "POST",
					json: { status: "draft", raw_text: text },
				});
			} else {
				await apiFetch<IntentDTO>(`/intents/${draftId}`, {
					method: "PATCH",
					json: { raw_text: text },
				});
			}
			navigate(PATHS.home);
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? cause.message
					: "下書きを保存できませんでした。もう一度お試しください",
			);
			setBusy(false);
		}
	};

	return (
		<div className="screen compose-screen">
			<ScreenGrain />
			<RouteToast text={toast} />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.home} aria-label="閉じる">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end">
					<button
						type="button"
						className="btn btn--quiet btn--small"
						onClick={() => void onSaveDraft()}
						disabled={busy || restoring}
					>
						下書きに残す
					</button>
				</div>
			</header>
			<div className="screen__body pad compose-body" style={{ paddingTop: 4 }}>
				<p className="t-eyebrow">置く</p>
				<h1 className="t-display t-display--s" style={{ marginTop: 10 }}>
					どんな人と、どんなふうに繋がりたいですか。
				</h1>
				<p className="t-caption" id="c-hint" style={{ marginTop: 6 }}>
					{/* 便箋がいっぱい(上限字数)の状態はボードComposeFull.dc.htmlのヒントへ切り替える */}
					{count >= LIMITS.RAW_TEXT_MAX_LENGTH
						? `${LIMITS.RAW_TEXT_MAX_LENGTH}字まで書けます。`
						: "日時や場所が決まっているなら、そのまま書いてください。"}
				</p>
				<div className="compose">
					<label className="sr-only" htmlFor="c-text">
						繋がりたいこと({LIMITS.RAW_TEXT_MAX_LENGTH}字まで)
					</label>
					<textarea
						className="compose__area compose__rule"
						id="c-text"
						maxLength={LIMITS.RAW_TEXT_MAX_LENGTH}
						placeholder="例: イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。"
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
				</div>
			</div>
			<div className="screen__foot">
				{error !== null && (
					<p className="field__error" role="alert">
						{error}
					</p>
				)}
				<div
					className="row"
					style={{ justifyContent: "space-between", gap: 12 }}
				>
					<p className="privacy">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4" />
							<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
						</svg>
						ほかの人には表示されません。
					</p>
					<p className={counterClass} aria-live="polite">
						<b>{count}</b> / {LIMITS.RAW_TEXT_MAX_LENGTH}
					</p>
				</div>
				<button
					type="button"
					className="btn btn--primary btn--block"
					onClick={onRead}
					disabled={text.trim().length === 0 || restoring}
				>
					読み解く
				</button>
			</div>
		</div>
	);
}
