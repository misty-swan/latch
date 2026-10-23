/**
 * Jevのreal実装(第一候補TypeSafe・docs/07 §5・設計書§5.1)。
 * POST /v1/systemone へ7軸のnoul問いを1回で送り、answers[軸].noul(0〜1)を取り出す。
 * 送るのは両Intentの正規化テキストだけ(raw_text不送・01 §13)。
 * 失敗は例外でなく型付きで返し、呼び出しの中で再試行しない(07 §5)。
 */
import {
	JEV_AXES,
	type JevAxes,
	type JevFn,
	type LlmFailureKind,
} from "../types";
import { JEV_QUESTIONS, TYPESAFE_MODEL } from "./prompts";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Jevの時間切れ(07 §5) */
export const JEV_TIMEOUT_MS = 6000;

/** 応答のanswersから7軸を取り出す。欠け・非数値・0〜1の外は null */
const extractAxes = (answers: unknown): JevAxes | null => {
	if (answers === null || typeof answers !== "object") return null;
	const axes: Partial<JevAxes> = {};
	for (const axis of JEV_AXES) {
		const v = (answers as Record<string, { noul?: unknown } | undefined>)[axis]
			?.noul;
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return null;
		}
		axes[axis] = v;
	}
	return axes as JevAxes;
};

export const typesafeJev =
	(deps: {
		apiKey: string;
		fetchFn?: typeof fetch;
		onModel?: (model: string) => void;
	}): JevFn =>
	async (input) => {
		const fetchFn = deps.fetchFn ?? fetch;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, JEV_TIMEOUT_MS);
		const fail = (kind: LlmFailureKind) => ({ ok: false, kind }) as const;

		try {
			const res = await fetchFn(TYPESAFE_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${deps.apiKey}`,
				},
				body: JSON.stringify({
					state: { intent_a: input.normalizedA, intent_b: input.normalizedB },
					model: TYPESAFE_MODEL,
					questions: Object.fromEntries(
						JEV_AXES.map((axis) => [
							axis,
							{ type: "noul", ...JEV_QUESTIONS[axis] },
						]),
					),
				}),
				signal: controller.signal,
			});
			if (res.status === 429) return fail("rate_limited");
			if (res.status === 503 || res.status === 529) return fail("overloaded");
			if (!res.ok) return fail("other");

			let body: { model?: unknown; answers?: unknown };
			try {
				body = (await res.json()) as typeof body;
			} catch {
				return fail(timedOut ? "timeout" : "invalid_output");
			}
			if (typeof body?.model === "string") deps.onModel?.(body.model);
			const axes = extractAxes(body?.answers);
			return axes ? { ok: true, axes } : fail("invalid_output");
		} catch {
			return fail(timedOut ? "timeout" : "other");
		} finally {
			clearTimeout(timer);
		}
	};
