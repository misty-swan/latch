/**
 * 読み解き確認画面(ボード: ConfirmConnection.dc.html・ConfirmOccasion.dc.html・
 * LimitReached.dc.htmlの移植)。
 * - parse結果(composeState経由)を「こう読み解きました。」で示し・預け方と条件を編集して預ける
 * - 預け方の切替で必須項目が替わる(機会=日時必須・予算・お酒/つながり=期限7・30・90日・既定30)
 * - 「預ける」は新規ならPOST /v1/intents・下書き再開ならPATCH /v1/intents/{id}で
 *   status:"active"にする。クライアントはversionを送らない(楽観ロックはサーバー側の判定・docs/05 §3.3)
 * - 422 ACTIVE_INTENT_LIMITはボードLimitReached.dc.htmlどおりのシートを出し・
 *   内容を下書きに残せる。400 VALIDATION_FAILEDはreasonsを人間向けに表示する
 * - 地域はF2'では「指定なし(全国)」固定(地名データはF3で取り込み)
 * ボードに無い行内の編集UI(主題・日時・予算・人数の入力)とエラー領域は実装の裁量
 */

import {
	BUDGET_MAX,
	CONSTRAINT_ITEM_MAX_LENGTH,
	CONSTRAINT_MAX_ITEMS,
	EXPIRY_CHOICES_DAYS,
	type IntentDTO,
	LIMITS,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
	type ParseIntentResponse,
} from "@latch/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../api/client";
import { clearComposeState, readComposeState } from "../intents/composeState";
import {
	buildCreateIntentRequest,
	buildPatchIntentRequest,
	type ConfirmValues,
	confirmValuesFromParse,
	connectionExpiryCaption,
	EMPTY_PARSE,
	formatExpiryClockJst,
	formatStartJst,
	isoFromLocalInput,
	occasionDefaultExpiryIso,
	validateConfirmValues,
} from "../intents/submit";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

/** 行内編集の対象(factsの各行。ボードに編集UIが無いため・行の鉛筆で開閉する) */
type EditingField = "topic" | "time" | "budget" | "participants";

/** サーバーの理由コード(docs/05 §3.3)→人間向けの案内。ボードに理由別の文言が無いため実装の裁量 */
const REASON_MESSAGES: Record<string, string> = {
	form_required: "預け方を選んでください",
	topic_required: "主題を入力してください",
	starts_at_required: "日時を入力してください。機会は日時が必須です",
	starts_at_out_of_range: "日時は現在以降7日以内で指定してください",
	starts_at_not_allowed: "つながりとして預ける場合は日時を指定できません",
	alcohol_not_allowed: "つながりとして預ける場合は「お酒」を含められません",
	expires_at_not_allowed: "期限の指定をやり直してください",
	expires_at_before_start: "期限は日時より後になるようにしてください",
	expires_in_days_not_allowed: "機会の期限は日時から自動で決まります",
	expires_choice_on_draft: "期限の選択をやり直してください",
	version_conflict: "他の操作で内容が変わったため、もう一度お試しください",
};

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

const PencilIcon = () => (
	<svg className="ic ic--s" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M5 19h3.6L18.3 9.3a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L5 15.4z" />
		<path d="M13.4 7l3.6 3.6" />
	</svg>
);

const CloseIcon = () => (
	<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
	</svg>
);

/** 人数の表示。同一なら「2人(あなたと相手)」・幅なら「2〜4人」(ボードどおり) */
const formatParticipants = (participants: {
	min: number;
	max: number;
}): string =>
	participants.min === participants.max
		? `${participants.min}人(あなたと相手)`
		: `${participants.min}〜${participants.max}人`;

export function Confirm() {
	const navigate = useNavigate();
	// 表示と初期値は初回マウント時のcomposeStateで確定させる(読み出しは毎回Zod検証される)
	const [initial] = useState(() => readComposeState());
	const [initialValues] = useState<ConfirmValues>(() =>
		confirmValuesFromParse(initial?.parse ?? EMPTY_PARSE),
	);

	const [form, setForm] = useState(initialValues.form);
	const [topic, setTopic] = useState(initialValues.topic);
	const [startLocal, setStartLocal] = useState(initialValues.startLocal);
	const [participants, setParticipants] = useState(initialValues.participants);
	const [budget, setBudget] = useState(initialValues.budget);
	const [softConstraints, setSoftConstraints] = useState(
		initialValues.softConstraints,
	);
	const [alcoholInvolved, setAlcoholInvolved] = useState(
		initialValues.alcoholInvolved,
	);
	const [expiresInDays, setExpiresInDays] = useState(
		initialValues.expiresInDays,
	);
	const [busy, setBusy] = useState(false);
	const [errorMessages, setErrorMessages] = useState<string[]>([]);
	const [limitSheet, setLimitSheet] = useState(false);
	const [editing, setEditing] = useState<EditingField | null>(null);
	const [topicDraft, setTopicDraft] = useState("");
	const [budgetDraft, setBudgetDraft] = useState("");
	const [addingConstraint, setAddingConstraint] = useState(false);
	const [constraintDraft, setConstraintDraft] = useState("");
	// 行内編集の入力(a11y lintのnoAutofocusを避けるため・effectでフォーカスする)
	const editorInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		// 行内編集を開いたら入力へフォーカスする(閉じたときは何もしない)
		if (editing === null && !addingConstraint) {
			return;
		}
		editorInputRef.current?.focus();
	}, [editing, addingConstraint]);

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
		topic,
		category: initialValues.category,
		startLocal,
		participants,
		budget: form === "occasion" ? budget : null,
		softConstraints,
		alcoholInvolved: form === "occasion" ? alcoholInvolved : false,
		expiresInDays,
	});

	/** 預け方の切替。行が替わるため行内編集は閉じる */
	const onFormChange = (next: ConfirmValues["form"]): void => {
		setForm(next);
		setEditing(null);
		if (next === "occasion") {
			// 機会には条件の行が無い(ボードConfirmOccasionどおり)。
			// UIから消えた条件を送らないよう・切替時に空にする
			setSoftConstraints([]);
		}
	};

	const commitTopic = (): void => {
		const trimmed = topicDraft.trim();
		// 主題は1..40字。空と40字超(属性を迂回した入力)は確定せず前の値へ戻す
		if (trimmed.length > 0 && trimmed.length <= LIMITS.TOPIC_MAX_LENGTH) {
			setTopic(trimmed);
		}
		setEditing(null);
	};

	const commitConstraint = (): void => {
		const trimmed = constraintDraft.trim();
		if (
			trimmed.length > 0 &&
			!softConstraints.includes(trimmed) &&
			softConstraints.length < CONSTRAINT_MAX_ITEMS
		) {
			setSoftConstraints([...softConstraints, trimmed]);
		}
		setConstraintDraft("");
		setAddingConstraint(false);
	};

	const setMin = (next: number): void =>
		setParticipants((p) => ({
			...p,
			min: Math.min(Math.max(next, PARTICIPANTS_MIN), p.max),
		}));

	const setMax = (next: number): void =>
		setParticipants((p) => ({
			...p,
			max: Math.min(Math.max(next, p.min), PARTICIPANTS_MAX),
		}));

	const commitBudget = (): void => {
		const amount = Number(budgetDraft);
		if (Number.isFinite(amount) && amount >= 0) {
			const max = Math.min(Math.round(amount), BUDGET_MAX);
			// 予算は「〜円以内」(上限)で編集する。下限が上限を超えないように丸める
			setBudget((p) => ({
				min: Math.min(p?.min ?? 0, max),
				max,
				currency: "JPY",
			}));
		}
		setEditing(null);
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
				setErrorMessages(messagesFromApiError(cause));
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

	const startIso = form === "occasion" ? isoFromLocalInput(startLocal) : null;
	const startText = formatStartJst(startLocal);

	const topicRow = (
		<div className="fact">
			<dt className="fact__key">主題</dt>
			{editing === "topic" ? (
				<dd className="fact__val">
					<input
						className="fact-input"
						ref={editorInputRef}
						aria-label="主題"
						maxLength={LIMITS.TOPIC_MAX_LENGTH}
						value={topicDraft}
						onChange={(event) => setTopicDraft(event.target.value)}
						onBlur={commitTopic}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commitTopic();
							}
						}}
					/>
				</dd>
			) : (
				<>
					<dd className={`fact__val${topic === "" ? " fact__val--muted" : ""}`}>
						{topic === "" ? "未設定" : topic}
					</dd>
					<button
						className="icon-btn"
						type="button"
						aria-label="主題を直す"
						onClick={() => {
							setTopicDraft(topic);
							setEditing("topic");
						}}
					>
						<PencilIcon />
					</button>
				</>
			)}
		</div>
	);

	const timeRow = (
		<div className="fact">
			<dt className="fact__key">日時</dt>
			{editing === "time" ? (
				<dd className="fact__val">
					<input
						className="fact-input"
						ref={editorInputRef}
						type="datetime-local"
						aria-label="日時"
						value={startLocal}
						onChange={(event) => setStartLocal(event.target.value)}
						onBlur={() => setEditing(null)}
					/>
				</dd>
			) : (
				<>
					<dd
						className={`fact__val${startText === null ? " fact__val--muted" : ""}`}
					>
						{startText ?? "未設定"}
					</dd>
					<button
						className="icon-btn"
						type="button"
						aria-label="日時を直す"
						onClick={() => setEditing("time")}
					>
						<PencilIcon />
					</button>
				</>
			)}
		</div>
	);

	/** 地域(機会では「場所」)。F2'は指定なし(全国)固定のため・編集不可の注記を添える */
	const geoRow = (label: string) => (
		<div className="fact">
			<dt className="fact__key">{label}</dt>
			<dd className="fact__val fact__val--muted">
				指定なし(全国)
				<span className="fact__sub">いまは指定なし(全国)のみです</span>
			</dd>
			<button
				className="icon-btn"
				type="button"
				aria-label={`${label}を直す`}
				disabled
				title="地域は指定なし(全国)のみです"
			>
				<PencilIcon />
			</button>
		</div>
	);

	const chipsRow = (
		<div className="fact fact--chips">
			<dt className="fact__key">条件</dt>
			<dd className="chips">
				{softConstraints.map((constraint) => (
					<button
						className="chip"
						type="button"
						key={constraint}
						aria-label={`${constraint}を外す`}
						onClick={() =>
							setSoftConstraints(
								softConstraints.filter((item) => item !== constraint),
							)
						}
					>
						{constraint}
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
						</svg>
					</button>
				))}
				{addingConstraint ? (
					<input
						className="fact-input chip-input"
						ref={editorInputRef}
						aria-label="条件を入力"
						maxLength={CONSTRAINT_ITEM_MAX_LENGTH}
						value={constraintDraft}
						onChange={(event) => setConstraintDraft(event.target.value)}
						onBlur={commitConstraint}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commitConstraint();
							}
						}}
					/>
				) : (
					softConstraints.length < CONSTRAINT_MAX_ITEMS && (
						<button
							className="chip chip--add"
							type="button"
							onClick={() => {
								setConstraintDraft("");
								setAddingConstraint(true);
							}}
						>
							<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 5.5v13M5.5 12h13" />
							</svg>
							条件を足す
						</button>
					)
				)}
			</dd>
			<span />
		</div>
	);

	const participantsRow = (
		<div className="fact">
			<dt className="fact__key">人数</dt>
			{editing === "participants" ? (
				<dd className="fact__val">
					<span className="fact-stepper">
						<span className="t-caption">下限</span>
						<button
							className="icon-btn"
							type="button"
							aria-label="下限を減らす"
							disabled={participants.min <= PARTICIPANTS_MIN}
							onClick={() => setMin(participants.min - 1)}
						>
							−
						</button>
						<span>{participants.min}</span>
						<button
							className="icon-btn"
							type="button"
							aria-label="下限を増やす"
							disabled={participants.min >= participants.max}
							onClick={() => setMin(participants.min + 1)}
						>
							+
						</button>
					</span>
					<span className="fact-stepper">
						<span className="t-caption">上限</span>
						<button
							className="icon-btn"
							type="button"
							aria-label="上限を減らす"
							disabled={participants.max <= participants.min}
							onClick={() => setMax(participants.max - 1)}
						>
							−
						</button>
						<span>{participants.max}</span>
						<button
							className="icon-btn"
							type="button"
							aria-label="上限を増やす"
							disabled={participants.max >= PARTICIPANTS_MAX}
							onClick={() => setMax(participants.max + 1)}
						>
							+
						</button>
					</span>
				</dd>
			) : (
				<>
					<dd className="fact__val">{formatParticipants(participants)}</dd>
					<button
						className="icon-btn"
						type="button"
						aria-label="人数を直す"
						onClick={() => setEditing("participants")}
					>
						<PencilIcon />
					</button>
				</>
			)}
			{editing === "participants" && (
				<button
					className="icon-btn"
					type="button"
					aria-label="人数を閉じる"
					onClick={() => setEditing(null)}
				>
					<CloseIcon />
				</button>
			)}
		</div>
	);

	const budgetRow = (
		<div className="fact">
			<dt className="fact__key">予算</dt>
			{editing === "budget" ? (
				<dd className="fact__val">
					<input
						className="fact-input fact-input--number"
						ref={editorInputRef}
						type="number"
						aria-label="予算の上限(円)"
						min={0}
						max={BUDGET_MAX}
						step={100}
						value={budgetDraft}
						onChange={(event) => setBudgetDraft(event.target.value)}
						onBlur={commitBudget}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commitBudget();
							}
						}}
					/>
				</dd>
			) : (
				<>
					<dd
						className={`fact__val${budget === null ? " fact__val--muted" : ""}`}
					>
						{budget === null
							? "未設定"
							: `${budget.max.toLocaleString()}円以内`}
					</dd>
					<button
						className="icon-btn"
						type="button"
						aria-label="予算を直す"
						onClick={() => {
							setBudgetDraft(budget === null ? "" : String(budget.max));
							setEditing("budget");
						}}
					>
						<PencilIcon />
					</button>
				</>
			)}
		</div>
	);

	const alcoholRow = (
		<div className="fact">
			<dt className="fact__key">お酒</dt>
			<dd className="fact__val">
				{alcoholInvolved ? "含む" : "含まない"}
				<span className="fact__sub">20歳以上の方どうしでだけ届きます。</span>
			</dd>
			<div className="switch">
				<input
					type="checkbox"
					aria-label="お酒を含む"
					checked={alcoholInvolved}
					onChange={(event) => setAlcoholInvolved(event.target.checked)}
				/>
				<span />
			</div>
		</div>
	);

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
						{topicRow}
						{form === "occasion" && timeRow}
						{form === "occasion" && geoRow("場所")}
						{form === "connection" && chipsRow}
						{form === "connection" && geoRow("地域")}
						{participantsRow}
						{form === "occasion" && budgetRow}
						{form === "occasion" && alcoholRow}
					</dl>
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
				<button
					type="button"
					className="btn btn--primary btn--block"
					onClick={() => void onPlace()}
					disabled={busy}
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
