/**
 * stub LLMの型(docs/07 §2・§3)。
 * LATCH_LLM_MODEで切り替える3系統(Intent Parser / Embedding / Jev)の
 * 入出力をここに集約する。実装はstub/配下・束ねはmode.ts。
 */
import type { Category, IntentForm, ParseWarning } from "@latch/shared";

/** LLMの動作モード。既定stub・real適用は精度ゲート(07 §6)合格が条件 */
export type LlmMode = "stub" | "real";

/** Intent Parserの出力(07 §2(a)・05 §3.3)。stubはcategoryを常にnullで返す */
export interface ParserOutput {
	form: IntentForm;
	topic: string;
	category: Category | null;
	time: { start: string; end: null } | null;
	participants: { min: number; max: number };
	budget: { min: number; max: number } | null;
	alcohol_involved: boolean;
	/** 提案する期限の選択肢(JSTオフセット付きISO・05 §2.2)。機会で時刻未確定のときは空配列 */
	expires_at_options: string[];
	/** 判定不能NG条件の注意表示(warningSchema・05 §3.3と同形状)。人数の丸め等で載る */
	warnings: ParseWarning[];
}

/** Jevの7軸(07 §5・01 §13)。1リクエストで7軸を並列判定する */
export const JEV_AXES = [
	"would_a_accept_b",
	"would_b_accept_a",
	"purpose_fit",
	"mood_fit",
	"timing_fit",
	"social_fit",
	"latent_yes",
] as const;

export type JevAxis = (typeof JEV_AXES)[number];

/** Jevの出力。軸名→確率(0〜1の数値のみ・理由文は生成しない・07 §5) */
export type JevAxes = Record<JevAxis, number>;

/** Jevへの入力。両Intentの正規化テキストのみ(raw_text不送・01 §13) */
export interface JevInput {
	normalizedA: string;
	normalizedB: string;
}

/** LLM呼び出しの失敗種別(07 §5)。Jevの切替対象かどうかは isFallbackEligible で判定する */
export type LlmFailureKind =
	| "timeout"
	| "rate_limited"
	| "overloaded"
	| "invalid_output"
	| "other";

/** Jev呼び出しの失敗種別。LlmFailureKindの別名(既存の参照を保つ) */
export type JevFailureKind = LlmFailureKind;

/** Parser呼び出しの結果。失敗は例外でなく型付きで返す(Jevと同じ作法) */
export type ParserOutcome =
	| { ok: true; output: ParserOutput }
	| { ok: false; kind: LlmFailureKind };

/** Jev呼び出しの結果。失敗は例外でなく型付きで返す(07 §5) */
export type JevOutcome =
	| { ok: true; axes: JevAxes }
	| { ok: false; kind: JevFailureKind };

/** Jevの差し替え口。非同期・失敗型付き */
export type JevFn = (input: JevInput) => Promise<JevOutcome>;

/** fallbackモデルへ切り替える対象か。timeout/rate_limited/overloadedのみtrue(07 §5) */
export const isFallbackEligible = (kind: JevFailureKind): boolean =>
	kind === "timeout" || kind === "rate_limited" || kind === "overloaded";

/** LLMの3系統を束ねたインターフェース。clockは構築時に注入する(04 §4の時刻規律) */
export interface Llm {
	parser: (raw_text: string) => Promise<ParserOutcome>;
	embedding: (input: string) => Promise<number[]>;
	/** primary失敗(切替対象)時にfallbackへ切り替える(07 §5) */
	jev: { primary: JevFn; fallback: JevFn };
}
