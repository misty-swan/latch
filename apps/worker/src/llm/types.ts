/**
 * stub LLMの型(docs/07 §2・§3)。
 * LATCH_LLM_MODEで切り替える3系統(Intent Parser / Embedding / Jev)の
 * 入出力をここに集約する。実装はstub/配下・束ねはmode.ts。
 */
import type { IntentForm } from "@latch/shared";

/** LLMの動作モード。既定stub・real適用は精度ゲート(07 §6)合格が条件 */
export type LlmMode = "stub" | "real";

/** Intent Parser stubの出力(07 §2(a)・05 §3.3のstub対象フィールド) */
export interface ParserStubOutput {
	form: IntentForm;
	topic: string;
	category: null;
	time: { start: string; end: null } | null;
	participants: { min: number; max: number };
	budget: { min: number; max: number } | null;
	alcohol_involved: boolean;
	/** 提案する期限の選択肢(JSTオフセット付きISO・05 §2.2)。機会で時刻未確定のときは空配列 */
	expires_at_options: string[];
	warnings: [];
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

/** LLMの3系統を束ねたインターフェース。clockは構築時に注入する(04 §4の時刻規律) */
export interface Llm {
	parser: (raw_text: string) => ParserStubOutput;
	embedding: (input: string) => Promise<number[]>;
	jev: (input: JevInput) => JevAxes;
}
