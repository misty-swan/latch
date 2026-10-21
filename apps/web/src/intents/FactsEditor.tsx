/**
 * 「読み解いた条件」の行内編集(`<dl className="facts">`の中身)。
 * 読み解き確認画面と内容を直す画面の両方から使う(F8a設計 §1.4)。
 * - 値は呼び出し側が持ち、行の確定ごとにonChangeで新しい値を渡す
 * - 行内編集の開閉と入力途中の値はこの部品が持つ。預け方が替わると行内編集を閉じる
 * - 見出し(「読み解いた条件」)・預け方・期限は呼び出し側が描く
 * - readOnlyに"alcohol"を含むとお酒の行は表示のみ(activeのPATCHはお酒を直せない・05 §3.3)
 * - 地域はいまは「指定なし(全国)」固定のため・編集不可の注記を添える
 * ボードに無い行内の編集UI(主題・日時・予算・人数の入力)は実装の裁量
 */

import {
	BUDGET_MAX,
	CONSTRAINT_ITEM_MAX_LENGTH,
	CONSTRAINT_MAX_ITEMS,
	type IntentForm,
	LIMITS,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
} from "@latch/shared";
import { useEffect, useRef, useState } from "react";
import { type FactsValues, formatStartJst } from "./submit";

/** 行内編集の対象(factsの各行。ボードに編集UIが無いため・行の鉛筆で開閉する) */
type EditingField = "topic" | "time" | "budget" | "participants";

/** 表示のみにできる行 */
export type FactsReadOnlyField = "alcohol";

export interface FactsEditorProps {
	form: IntentForm;
	values: FactsValues;
	onChange: (next: FactsValues) => void;
	/** 行に添える検証の文言(validateConfirmValuesの結果) */
	errors: { topic?: string; start?: string };
	readOnly?: ReadonlyArray<FactsReadOnlyField>;
}

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

/** 行に添える検証の文言 */
const FieldError = ({ message }: { message: string | undefined }) =>
	message === undefined ? null : (
		<span className="field__error" role="alert">
			{message}
		</span>
	);

export function FactsEditor({
	form,
	values,
	onChange,
	errors,
	readOnly = [],
}: FactsEditorProps) {
	const { topic, startLocal, participants, budget, softConstraints } = values;
	const alcoholInvolved = values.alcoholInvolved;
	const [editing, setEditing] = useState<EditingField | null>(null);
	const [topicDraft, setTopicDraft] = useState("");
	const [budgetDraft, setBudgetDraft] = useState("");
	const [addingConstraint, setAddingConstraint] = useState(false);
	const [constraintDraft, setConstraintDraft] = useState("");
	// 預け方の切替で行が替わるため行内編集を閉じる(描画中に直前の預け方と比べて揃える)
	const [renderedForm, setRenderedForm] = useState(form);
	if (renderedForm !== form) {
		setRenderedForm(form);
		setEditing(null);
	}
	// 行内編集の入力(a11y lintのnoAutofocusを避けるため・effectでフォーカスする)
	const editorInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		// 行内編集を開いたら入力へフォーカスする(閉じたときは何もしない)
		if (editing === null && !addingConstraint) {
			return;
		}
		editorInputRef.current?.focus();
	}, [editing, addingConstraint]);

	const update = (patch: Partial<FactsValues>): void =>
		onChange({ ...values, ...patch });

	const commitTopic = (): void => {
		const trimmed = topicDraft.trim();
		// 主題は1..40字。空と40字超(属性を迂回した入力)は確定せず前の値へ戻す
		if (trimmed.length > 0 && trimmed.length <= LIMITS.TOPIC_MAX_LENGTH) {
			update({ topic: trimmed });
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
			update({ softConstraints: [...softConstraints, trimmed] });
		}
		setConstraintDraft("");
		setAddingConstraint(false);
	};

	const setMin = (next: number): void =>
		update({
			participants: {
				...participants,
				min: Math.min(Math.max(next, PARTICIPANTS_MIN), participants.max),
			},
		});

	const setMax = (next: number): void =>
		update({
			participants: {
				...participants,
				max: Math.min(Math.max(next, participants.min), PARTICIPANTS_MAX),
			},
		});

	const commitBudget = (): void => {
		const amount = Number(budgetDraft);
		if (Number.isFinite(amount) && amount >= 0) {
			const max = Math.min(Math.round(amount), BUDGET_MAX);
			// 予算は「〜円以内」(上限)で編集する。下限が上限を超えないように丸める
			update({
				budget: {
					min: Math.min(budget?.min ?? 0, max),
					max,
					currency: "JPY",
				},
			});
		}
		setEditing(null);
	};

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
						<FieldError message={errors.topic} />
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
						onChange={(event) => update({ startLocal: event.target.value })}
						onBlur={() => setEditing(null)}
					/>
				</dd>
			) : (
				<>
					<dd
						className={`fact__val${startText === null ? " fact__val--muted" : ""}`}
					>
						{startText ?? "未設定"}
						<FieldError message={errors.start} />
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

	/** 地域(機会では「場所」)。いまは指定なし(全国)固定のため・編集不可の注記を添える */
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
							update({
								softConstraints: softConstraints.filter(
									(item) => item !== constraint,
								),
							})
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
			{readOnly.includes("alcohol") ? (
				<span />
			) : (
				<div className="switch">
					<input
						type="checkbox"
						aria-label="お酒を含む"
						checked={alcoholInvolved}
						onChange={(event) =>
							update({ alcoholInvolved: event.target.checked })
						}
					/>
					<span />
				</div>
			)}
		</div>
	);

	return (
		<>
			{topicRow}
			{form === "occasion" && timeRow}
			{form === "occasion" && geoRow("場所")}
			{form === "connection" && chipsRow}
			{form === "connection" && geoRow("地域")}
			{participantsRow}
			{form === "occasion" && budgetRow}
			{form === "occasion" && alcoholRow}
		</>
	);
}
