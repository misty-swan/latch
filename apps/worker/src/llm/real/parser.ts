/**
 * Intent Parserのreal実装(docs/07 §3・設計書§4)。Anthropicの構造化出力を呼び、
 * 返りをzodで検証してParserOutputへ写す。送る利用者情報はraw_textと現在時刻(JST)だけ。
 * 期限の選択肢はモデルに作らせずコードで求める(stubと同じ共有部品)。
 * 失敗は例外でなく型付きで返し、呼び出しの中で再試行しない(07 §3)。
 */
import {
	CATEGORIES,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
	warningSchema,
} from "@latch/shared";
import { z } from "zod";
import type { Clock } from "../../clock/clock";
import { expiryOptions, toJstIso } from "../expiry";
import { PARTICIPANTS_WARNING } from "../stub/parser";
import type { ParserOutcome, ParserOutput } from "../types";
import { callAnthropicJson } from "./anthropic";
import { PARSER_OUTPUT_SCHEMA, PARSER_SYSTEM_PROMPT } from "./prompts";

/** Parserの時間切れ(07 §3) */
const PARSER_TIMEOUT_MS = 10_000;

/** time.start: YYYY-MM-DDTHH:MM:SS+09:00 で、実在する日時であること */
const jstIso = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/)
	.refine((s) => !Number.isNaN(new Date(s).getTime()));

/** モデルの人数は正の整数なら受け、2〜4人への丸めは後段で行う(07 §3) */
const participantCount = z.number().int().positive();

const clampParticipants = (n: number): number =>
	Math.min(Math.max(n, PARTICIPANTS_MIN), PARTICIPANTS_MAX);

const modelOutputSchema = z.object({
	form: z.enum(["connection", "occasion"]),
	topic: z.string().min(1),
	category: z.enum(CATEGORIES).nullable(),
	time: z.object({ start: jstIso, end: z.null() }).nullable(),
	participants: z
		.object({ min: participantCount, max: participantCount })
		.refine((p) => p.min <= p.max),
	budget: z
		.object({ min: z.number().int().nonnegative(), max: z.number().int() })
		.refine((b) => b.min <= b.max)
		.nullable(),
	alcohol_involved: z.boolean(),
	warnings: z.array(warningSchema),
});

export const realParser =
	(deps: { apiKey: string; clock: Clock; fetchFn?: typeof fetch }) =>
	async (raw_text: string): Promise<ParserOutcome> => {
		const res = await callAnthropicJson({
			apiKey: deps.apiKey,
			system: PARSER_SYSTEM_PROMPT(toJstIso(deps.clock.now())),
			user: raw_text,
			schema: PARSER_OUTPUT_SCHEMA,
			timeoutMs: PARSER_TIMEOUT_MS,
			fetchFn: deps.fetchFn,
		});
		if (!res.ok) return { ok: false, kind: res.kind };

		const parsed = modelOutputSchema.safeParse(res.value);
		if (!parsed.success) return { ok: false, kind: "invalid_output" };
		const v = parsed.data;
		// 範囲外の人数は2〜4人へ丸め、注意表示を載せる(stubと同じ・モデルが載せ済みなら重ねない)
		const participants = {
			min: clampParticipants(v.participants.min),
			max: clampParticipants(v.participants.max),
		};
		const clamped =
			participants.min !== v.participants.min ||
			participants.max !== v.participants.max;
		const warnings =
			clamped && !v.warnings.some((w) => w.field === "participants")
				? [...v.warnings, PARTICIPANTS_WARNING]
				: v.warnings;
		const output: ParserOutput = {
			form: v.form,
			topic: v.topic,
			category: v.category,
			time: v.time,
			participants,
			budget: v.budget,
			alcohol_involved: v.alcohol_involved,
			// モデルの値は使わない(設計書§4)
			expires_at_options: expiryOptions(deps.clock, v.form, v.time),
			warnings,
		};
		return { ok: true, output };
	};
