/**
 * Jevの予備(Anthropic・docs/07 §5・設計書§5.2)。TypeSafeが時間切れ・混雑のときだけ使う。
 * 7軸の確率の数値だけを構造化出力で返させ、範囲は受け取った後に検証する。
 */
import { JEV_AXES, type JevAxes, type JevFn } from "../types";
import { callAnthropicJson } from "./anthropic";
import { JEV_ANTHROPIC_SYSTEM_PROMPT, JEV_OUTPUT_SCHEMA } from "./prompts";

const JEV_TIMEOUT_MS = 6000;

/** {軸: 数値} から7軸を取り出す。欠け・非数値・0〜1の外は null */
const extractFlatAxes = (value: unknown): JevAxes | null => {
	if (value === null || typeof value !== "object") return null;
	const axes: Partial<JevAxes> = {};
	for (const axis of JEV_AXES) {
		const v = (value as Record<string, unknown>)[axis];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return null;
		}
		axes[axis] = v;
	}
	return axes as JevAxes;
};

export const anthropicJev =
	(deps: { apiKey: string; fetchFn?: typeof fetch }): JevFn =>
	async (input) => {
		const res = await callAnthropicJson({
			apiKey: deps.apiKey,
			system: JEV_ANTHROPIC_SYSTEM_PROMPT,
			user: `intent_a: ${input.normalizedA}\nintent_b: ${input.normalizedB}`,
			schema: JEV_OUTPUT_SCHEMA,
			timeoutMs: JEV_TIMEOUT_MS,
			fetchFn: deps.fetchFn,
		});
		if (!res.ok) return { ok: false, kind: res.kind };
		const axes = extractFlatAxes(res.value);
		return axes ? { ok: true, axes } : { ok: false, kind: "invalid_output" };
	};
