/**
 * 読み解き確認画面(ボード: ConfirmConnection.dc.html・ConfirmOccasion.dc.html・
 * LimitReached.dc.htmlの移植)。
 * - parse結果(composeState経由)を「こう読み解きました。」で示し・預け方と条件を編集して預ける
 * - 預け方の切替で必須項目が替わる(機会=日時必須・予算・お酒/つながり=期限7・30・90日・既定30)
 * - 「預ける」は新規ならPOST /v1/intents・下書き再開ならPATCH /v1/intents/{id}で
 *   status:"active"にする。クライアントはversionを送らない(楽観ロックはサーバー側の判定・docs/05 §3.3)
 * - 422 ACTIVE_INTENT_LIMITはボードLimitReached.dc.htmlどおりのシートを出し・
 *   内容を下書きに残せる。400 VALIDATION_FAILEDはreasonsを人間向けに表示する
 * - 422 ALCOHOL_RESTRICTED(満20歳未満・年齢を確かめられない・08 §8)はボード
 *   AlcoholRestricted.dc.htmlどおりお酒の行の下と足元に案内を出し、お酒がオンのあいだ
 *   預けるを止める。年齢は画面で計算しない(判定の正はサーバー・F7c設計 §1.9)
 * - 地域はF2'では「指定なし(全国)」固定(地名データはF3で取り込み)
 * - 「読み解いた条件」の行内編集(主題・日時・予算・人数・条件・お酒)はintents/FactsEditorが受け持つ
 * ボードに無い行内の編集UI(主題・日時・予算・人数の入力)とエラー領域は実装の裁量
 */

import {
	EXPIRY_CHOICES_DAYS,
	type IntentDTO,
	type ParseIntentResponse,
} from "@latch/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../api/client";
import { clearComposeState, readComposeState } from "../intents/composeState";
import { FactsEditor } from "../intents/FactsEditor";
import {
	buildCreateIntentRequest,
	buildPatchIntentRequest,
	type ConfirmValues,
	confirmValuesFromParse,
	connectionExpiryCaption,
	EMPTY_PARSE,
	type FactsValues,
	formatExpiryClockJst,
	isoFromLocalInput,
	occasionDefaultExpiryIso,
	REASON_MESSAGES,
	validateConfirmValues,
} from "../intents/submit";
import { isOfflineError, OFFLINE_MESSAGES } from "../offline/errors";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

/** エラー応答を人間向けの行に正規化する(理由コードの既知分は案内へ・未知分はコードのまま) */
const messagesFromApiError = (error: ApiError): string[] => {
	if (error.code === "VALIDATION_FAILED") {
		const raw = error.details.reasons;
		const reasons = Array.isArray(raw)
			? raw.filter((reason): reason is string => typeof reason === "string")
			: [];
		if (reasons.length > 0) {
			return reasons.map((reason) => REASON_MESSAGES[reason] ?? reason);
		}
	}
	return [`${error.code}: ${error.message}`];
};

/** 案内の印(ボードAlcoholRestrictedの丸いi) */
const InfoIcon = ({ small = false }: { small?: boolean }) => (
	<svg
		className={small ? "ic ic--xs" : "ic"}
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="8.5" />
		<path d="M12 11v5.2" />
		<circle cx="12" cy="7.9" r=".9" fill="currentColor" stroke="none" />
	</svg>
);

export function Confirm() {
	const navigate = useNavigate();
	// 表示と初期値は初回マウント時のcomposeStateで確定させる(読み出しは毎回Zod検証される)
	const [initial] = useState(() => readComposeState());
	const [initialValues] = useState<ConfirmValues>(() =>
		confirmValuesFromParse(initial?.parse ?? EMPTY_PARSE),
	);

	const [form, setForm] = useState(initialValues.form);
	// 「読み解いた条件」の各行の値(行内編集はFactsEditorが受け持つ)
	const [facts, setFacts] = useState<FactsValues>(() => ({
		topic: initialValues.topic,
		startLocal: initialValues.startLocal,
		participants: initialValues.participants,
		budget: initialValues.budget,
		softConstraints: initialValues.softConstraints,
		alcoholInvolved: initialValues.alcoholInvolved,
	}));
	const [expiresInDays, setExpiresInDays] = useState(
		initialValues.expiresInDays,
	);
	const [busy, setBusy] = useState(false);
	const [errorMessages, setErrorMessages] = useState<string[]>([]);
	const [limitSheet, setLimitSheet] = useState(false);
	// 422 ALCOHOL_RESTRICTEDを受けた印。お酒をオフにすると下ろす
	const [alcoholRestricted, setAlcoholRestricted] = useState(false);
	const rawText = initial?.raw_text ?? "";
	const draftId = initial?.draft_id ?? null;
	const parse: ParseIntentResponse | null = initial?.parse ?? null;

	useEffect(() => {
		if (initial === null) {
			// 入力が無い直アクセス・受け渡し状態の寿命切れはcomposeへ送り返す
			navigate(PATHS.compose, { replace: true });
		}
	}, [initial, navigate]);

	/** 画面で編集中の値を組てる(送信・検証で使う) */
	const currentValues = (): ConfirmValues => ({
		form,
		topic: facts.topic,
		category: initialValues.category,
		startLocal: facts.startLocal,
		participants: facts.participants,
		budget: form === "occasion" ? facts.budget : null,
		softConstraints: facts.softConstraints,
		alcoholInvolved: form === "occasion" ? facts.alcoholInvolved : false,
		expiresInDays,
	});

	/** 預け方の切替(行が替わるため行内編集はFactsEditorが閉じる) */
	const onFormChange = (next: ConfirmValues["form"]): void => {
		setForm(next);
		if (next === "occasion") {
			// 機会には条件の行が無い(ボードConfirmOccasionどおり)。
			// UIから消えた条件を送らないよう・切替時に空にする
			setFacts((f) => ({ ...f, softConstraints: [] }));
		}
	};

	/** 行の確定。お酒をオフにしたら422 ALCOHOL_RESTRICTEDの印を下ろす */
	const onFactsChange = (next: FactsValues): void => {
		if (facts.alcoholInvolved && !next.alcoholInvolved) {
			setAlcoholRestricted(false);
		}
		setFacts(next);
	};

	/** 「預ける」。新規はPOST・下書き再開はPATCHでactive化する */
	const onPlace = async (): Promise<void> => {
		if (busy) {
			return;
		}
		const fieldErrors = validateConfirmValues(currentValues());
		const clientMessages = [fieldErrors.topic, fieldErrors.start].filter(
			(message): message is string => message !== undefined,
		);
		if (clientMessages.length > 0) {
			setErrorMessages(clientMessages);
			return;
		}
		const request =
			draftId === null
				? buildCreateIntentRequest(currentValues(), rawText)
				: buildPatchIntentRequest(currentValues(), rawText);
		if (request === null) {
			setErrorMessages(["入力を保存できません。各条件を確かめてください"]);
			return;
		}
		setBusy(true);
		setErrorMessages([]);
		try {
			if (draftId === null) {
				await apiFetch<IntentDTO>("/intents", {
					method: "POST",
					json: request,
				});
			} else {
				await apiFetch<IntentDTO>(`/intents/${draftId}`, {
					method: "PATCH",
					json: request,
				});
			}
			// 受け渡し状態は預けた画面(Placed)が消費して破棄する
			navigate(PATHS.placed);
		} catch (cause) {
			setBusy(false);
			if (cause instanceof ApiError) {
				if (cause.code === "ACTIVE_INTENT_LIMIT") {
					// 上限(5件)に当たった。ボードLimitReached.dc.htmlどおりのシートを出す
					setLimitSheet(true);
					return;
				}
				if (cause.code === "ALCOHOL_RESTRICTED") {
					// 汎用のエラー行は出さず・ボードAlcoholRestrictedどおりの案内に替える
					setAlcoholRestricted(true);
					return;
				}
				setErrorMessages(messagesFromApiError(cause));
			} else if (isOfflineError(cause)) {
				setErrorMessages([OFFLINE_MESSAGES.generic]);
			} else {
				setErrorMessages(["預けられませんでした。もう一度お試しください"]);
			}
		}
	};

	/** 上限シートの「下書きに残す」(ボードのHome導線に保存を添えたもの) */
	const onSaveDraft = async (): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		try {
			if (draftId === null) {
				await apiFetch<IntentDTO>("/intents", {
					method: "POST",
					json: { status: "draft", raw_text: rawText },
				});
			} else {
				await apiFetch<IntentDTO>(`/intents/${draftId}`, {
					method: "PATCH",
					json: { raw_text: rawText },
				});
			}
			clearComposeState();
			navigate(PATHS.home);
		} catch (cause) {
			setBusy(false);
			setLimitSheet(false);
			setErrorMessages(
				cause instanceof ApiError
					? messagesFromApiError(cause)
					: ["下書きを保存できませんでした。もう一度お試しください"],
			);
		}
	};

	if (initial === null || parse === null) {
		// 直アクセスではcomposeへ送り返す(effectの遷移までの間の描画)
		return null;
	}

	const startIso =
		form === "occasion" ? isoFromLocalInput(facts.startLocal) : null;
	// お酒を含む機会のままでは預けられない状態(つながりへ切り替えた場合はお酒を送らないため解除)
	const alcoholBlocked =
		alcoholRestricted && form === "occasion" && facts.alcoholInvolved;

	return (
		<div className="screen confirm">
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
				style={{ paddingTop: 4, paddingBottom: 24 }}
			>
				<h1 className="t-display t-display--s">こう読み解きました。</h1>
				<div
					className="row"
					style={{ gap: 12, marginTop: 16, alignItems: "flex-start" }}
				>
					<p className="quote clamp-2" style={{ flex: 1 }}>
						{rawText}
					</p>
					<Link
						className="btn btn--quiet btn--small"
						style={{ margin: "-6px -12px 0 0" }}
						to={PATHS.compose}
					>
						文章を直す
					</Link>
				</div>
				<section style={{ marginTop: 28 }}>
					<h2 className="t-label">預け方</h2>
					<div
						className="choice"
						role="radiogroup"
						aria-label="預け方"
						style={{ marginTop: 12 }}
					>
						<label className="choice__opt">
							<input
								type="radio"
								name="form"
								value="connection"
								checked={form === "connection"}
								onChange={() => onFormChange("connection")}
							/>
							<span className="choice__card">
								<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
									<path className="gt" d="M10.9 1.5A8.5 8.5 0 0 1 10.9 18.5" />
									<path className="gm" d="M9.1 1.5A8.5 8.5 0 0 0 9.1 18.5Z" />
								</svg>
								<span className="choice__name">つながりとして預ける</span>
								<span className="choice__hint">すぐ会う予定はない</span>
							</span>
						</label>
						<label className="choice__opt">
							<input
								type="radio"
								name="form"
								value="occasion"
								checked={form === "occasion"}
								onChange={() => onFormChange("occasion")}
							/>
							<span className="choice__card">
								<svg className="glyph" viewBox="0 0 20 20" aria-hidden="true">
									<path className="gl" d="M11.3 1.5A8.5 8.5 0 0 1 11.3 18.5Z" />
									<path className="gm" d="M8.7 1.5A8.5 8.5 0 0 0 8.7 18.5Z" />
								</svg>
								<span className="choice__name">機会として預ける</span>
								<span className="choice__hint">日時がある</span>
							</span>
						</label>
					</div>
				</section>
				<section style={{ marginTop: 30 }}>
					<h2 className="t-label">読み解いた条件</h2>
					<dl className="facts" style={{ marginTop: 8 }}>
						<FactsEditor
							form={form}
							values={facts}
							errors={{}}
							onChange={onFactsChange}
						/>
					</dl>
					{alcoholBlocked && (
						<p className="note note--lamp" style={{ marginTop: 14 }}>
							<InfoIcon />
							<span>
								<b>お酒を含む機会は、20歳以上の方が預けられます。</b>
								「お酒」をオフにすると、このまま預けられます。
							</span>
						</p>
					)}
				</section>
				{form === "connection" ? (
					<section style={{ marginTop: 30 }}>
						<h2 className="t-label">期限</h2>
						<div style={{ marginTop: 12 }}>
							<div className="pills" role="radiogroup" aria-label="期限">
								{EXPIRY_CHOICES_DAYS.map((days) => (
									<label className="pill" key={days}>
										<input
											type="radio"
											name="days"
											value={days}
											checked={expiresInDays === days}
											onChange={() => setExpiresInDays(days)}
										/>
										<span>
											<b>{days}</b>日
										</span>
									</label>
								))}
							</div>
							<p className="t-caption" style={{ marginTop: 10 }}>
								{`${connectionExpiryCaption(
									parse.expires_at_options,
									expiresInDays,
								)}まで預けます。期限が来たら、お知らせします。`}
							</p>
						</div>
					</section>
				) : (
					<section style={{ marginTop: 30 }}>
						<h2 className="t-label">期限</h2>
						<div style={{ marginTop: 12 }}>
							{startIso !== null && (
								<p className="t-body" style={{ color: "var(--ink)" }}>
									{`開始から3時間後(${formatExpiryClockJst(
										occasionDefaultExpiryIso(startIso),
									)})まで`}
								</p>
							)}
							<p
								className="t-caption"
								style={{ marginTop: startIso === null ? 0 : 4 }}
							>
								機会の期限は、日時から自動で決まります。
							</p>
						</div>
					</section>
				)}
				<p className="privacy" style={{ marginTop: 28 }}>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4" />
						<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
					</svg>
					文章そのものは、相手にも表示されません。
				</p>
			</div>
			<div className="screen__foot">
				{errorMessages.map((message) => (
					<p key={message} className="field__error" role="alert">
						{message}
					</p>
				))}
				{alcoholBlocked && (
					<p className="foot-reason">
						<InfoIcon small />
						お酒を含む機会は、20歳以上の方が預けられます。
					</p>
				)}
				<button
					type="button"
					className="btn btn--primary btn--block"
					onClick={() => void onPlace()}
					disabled={busy || alcoholBlocked}
				>
					預ける
				</button>
			</div>
			{limitSheet && (
				<>
					{/* 背景タップで閉じる(ボードに無い操作・シートを出したまま編集へ戻れる) */}
					<div
						className="backdrop"
						aria-hidden="true"
						onClick={() => setLimitSheet(false)}
					/>
					<div
						className="sheet-layer"
						role="dialog"
						aria-modal="true"
						aria-label="預けられる数の上限"
					>
						<div className="sheet">
							<span className="sheet__grab" aria-hidden="true" />
							<h2 className="sheet__title">
								同時に預けておけるのは、5つまでです。
							</h2>
							<p className="t-body">
								いま預けている意思のどれかを一時停止するか、取り下げると、新しく預けられます。この内容は下書きに残せます。
							</p>
							<div className="sheet__actions">
								<button
									type="button"
									className="btn btn--primary btn--block"
									onClick={() => void onSaveDraft()}
									disabled={busy}
								>
									下書きに残す
								</button>
								<button
									type="button"
									className="btn btn--secondary btn--block"
									onClick={() => navigate(PATHS.home)}
								>
									預けている一覧へ
								</button>
							</div>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
