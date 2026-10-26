/**
 * 精度ゲートの採点の実行(設計書 §3.1)。ゴールドセットをworkerのreal実装へ流し、
 * 採点(score.ts)と合否をまとめた記録を返す。ファイルへの書き出しと標準出力はgate.tsが行う。
 *
 * - 呼び出しは同時に数件まで(既定4)に絞る
 * - 429(rate_limited)はRetry-Afterだけ待って呼び直す(採点の中だけ。本番の経路は再試行しない)
 * - 記録にはAPIキー・URL・応答の本文を入れない(件のidと項目・数値だけ)
 */
import { join } from "node:path";
import { fixedClock } from "../../../apps/worker/src/clock/clock";
import { anthropicJev } from "../../../apps/worker/src/llm/real/jev-anthropic";
import { typesafeJev } from "../../../apps/worker/src/llm/real/jev-typesafe";
import { realParser } from "../../../apps/worker/src/llm/real/parser";
import {
	ANTHROPIC_MODEL,
	TYPESAFE_MODEL,
} from "../../../apps/worker/src/llm/real/prompts";
import type {
	JevInput,
	JevOutcome,
	ParserOutcome,
} from "../../../apps/worker/src/llm/types";
import { buildNormalizedText } from "../../../apps/worker/src/pipeline/normalize";
import { artifactsFingerprint, fingerprint } from "./fingerprint";
import { jevScoredPairs, loadJevGoldset, loadParserGoldset } from "./goldset";
import { fixtureToRow } from "./intent-row";
import {
	type GateScores,
	judge,
	precisionAt,
	scoreJevOrder,
	scoreParser,
} from "./score";

/** 同時に呼ぶ件数の既定 */
const DEFAULT_CONCURRENCY = 4;
/** 429の呼び直しの上限回数 */
const MAX_RETRIES = 5;
/** Retry-Afterが無い・読めないときの待ち時間と、待ち時間の上限 */
const DEFAULT_RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;

export type GateRecord = {
	ranAt: string;
	passed: boolean;
	failures: string[];
	scores: GateScores;
	reference: {
		latencyP95Ms: {
			parser: number | null;
			jevPrimary: number | null;
			jevFallback: number | null;
		};
		/** Anthropicの1回あたりの入力トークンの平均(応答のusageから。TypeSafeは数えない) */
		inputTokensMean: { parser: number | null; jevFallback: number | null };
	};
	models: {
		anthropic: string;
		typesafe_requested: string;
		/** TypeSafeの応答のmodel(重複を除き昇順) */
		typesafe_answered: string[];
	};
	goldset: {
		parserVersion: number;
		jevVersion: number;
		/** 両方の承認日のうち遅い方。どちらかが未承認ならnull */
		approvedByOwner: string | null;
	};
	fingerprint: Record<string, string>;
	/** モデルとのやり取りを形づくる値を描いた形の指紋(fingerprint.tsのartifactsFingerprint) */
	fingerprintArtifacts: string;
};

export type GateDeps = {
	repoRoot: string;
	keys: { anthropic: string; typesafe: string };
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
	concurrency?: number;
};

/** Retry-Afterの値(秒数またはHTTPの日時)を待ち時間(ミリ秒)へ。上限60秒 */
export const parseRetryAfter = (value: string | null, now: Date): number => {
	if (value === null) return DEFAULT_RETRY_MS;
	const trimmed = value.trim();
	let ms: number;
	if (/^\d+$/.test(trimmed)) {
		ms = Number(trimmed) * 1000;
	} else {
		const at = Date.parse(trimmed);
		if (Number.isNaN(at)) return DEFAULT_RETRY_MS;
		ms = Math.max(0, at - now.getTime());
	}
	return Math.min(ms, MAX_RETRY_MS);
};

/** 件の順を保ったまま、同時にlimit件までで非同期処理を流す */
const mapLimit = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
};

const p95 = (xs: number[]): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.ceil(s.length * 0.95) - 1] as number;
};

const mean = (xs: number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

type Outcome = ParserOutcome | JevOutcome;

/** 1回の呼び出しの観測(応答時間・入力トークン)を集める入れ物 */
type Probe = { latencies: number[]; inputTokens: number[] };

export const runGate = async (deps: GateDeps): Promise<GateRecord> => {
	const baseFetch = deps.fetchFn ?? fetch;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = deps.now ?? (() => new Date());
	const limit = deps.concurrency ?? DEFAULT_CONCURRENCY;

	const parserSet = loadParserGoldset(
		join(deps.repoRoot, "eval/goldset/parser.yaml"),
	);
	const jevSet = loadJevGoldset(
		join(deps.repoRoot, "eval/goldset/jev-pairs.yaml"),
	);
	// 採点の前のファイルで指紋を取る(採点中の変更を合格に混ぜない)
	const fp = fingerprint(deps.repoRoot);
	const fpArtifacts = artifactsFingerprint();
	const ranAt = now().toISOString();

	/**
	 * 呼び出し1件を、429のときRetry-Afterだけ待って呼び直す。
	 * fetchを包んで、最後の429のRetry-Afterと、成功した応答のusage.input_tokensだけを読む
	 */
	const callWithRetry = async <O extends Outcome>(
		probe: Probe,
		call: (fetchFn: typeof fetch) => Promise<O>,
	): Promise<O> => {
		for (let attempt = 0; ; attempt++) {
			let retryAfter: string | null = null;
			let tokens: number | null = null;
			const fetchFn = (async (
				input: string | URL | Request,
				init?: RequestInit,
			) => {
				const res = await baseFetch(input, init);
				if (res.status === 429) retryAfter = res.headers.get("retry-after");
				if (res.ok) {
					try {
						const usage = (
							(await res.clone().json()) as {
								usage?: { input_tokens?: unknown };
							}
						)?.usage;
						if (typeof usage?.input_tokens === "number") {
							tokens = usage.input_tokens;
						}
					} catch {
						// 本文が読めない応答はreal実装の側で失敗として扱われる
					}
				}
				return res;
			}) as typeof fetch;
			const started = performance.now();
			const outcome = await call(fetchFn);
			if (
				!outcome.ok &&
				outcome.kind === "rate_limited" &&
				attempt < MAX_RETRIES
			) {
				await sleep(parseRetryAfter(retryAfter, now()));
				continue;
			}
			probe.latencies.push(performance.now() - started);
			if (tokens !== null) probe.inputTokens.push(tokens);
			return outcome;
		}
	};

	// ---- Parser ----
	const parserProbe: Probe = { latencies: [], inputTokens: [] };
	const parserOutcomes = await mapLimit(parserSet.items, limit, (item) =>
		callWithRetry(parserProbe, (fetchFn) =>
			realParser({
				apiKey: deps.keys.anthropic,
				clock: fixedClock(new Date(item.now)),
				fetchFn,
			})(item.raw_text),
		),
	);

	// ---- Jev((A,B)と(B,A)・第一候補と予備) ----
	// jev_scored: false の組(noの理由がLayer 1の条件で正規化テキストに出ない組)はJevへ送らない(LAT-114)
	const jevPairs = jevScoredPairs(jevSet.pairs);
	const inputs = jevPairs.map((p) => {
		const a = buildNormalizedText(fixtureToRow(p.a));
		const b = buildNormalizedText(fixtureToRow(p.b));
		return {
			ab: { normalizedA: a, normalizedB: b },
			ba: { normalizedA: b, normalizedB: a },
		};
	});
	const answered = new Set<string>();
	const runJev = async (
		probe: Probe,
		make: (fetchFn: typeof fetch) => (input: JevInput) => Promise<JevOutcome>,
		order: "ab" | "ba",
	) =>
		mapLimit(inputs, limit, (input) =>
			callWithRetry(probe, (fetchFn) => make(fetchFn)(input[order])),
		);
	const typesafe = (fetchFn: typeof fetch) =>
		typesafeJev({
			apiKey: deps.keys.typesafe,
			fetchFn,
			onModel: (m) => answered.add(m),
		});
	const anthropic = (fetchFn: typeof fetch) =>
		anthropicJev({ apiKey: deps.keys.anthropic, fetchFn });

	const primaryProbe: Probe = { latencies: [], inputTokens: [] };
	const fallbackProbe: Probe = { latencies: [], inputTokens: [] };
	const primaryAb = await runJev(primaryProbe, typesafe, "ab");
	const primaryBa = await runJev(primaryProbe, typesafe, "ba");
	const fallbackAb = await runJev(fallbackProbe, anthropic, "ab");
	const fallbackBa = await runJev(fallbackProbe, anthropic, "ba");

	const scores: GateScores = {
		parser: scoreParser(parserSet.items, parserOutcomes),
		jev: {
			primary: scoreJevOrder(jevPairs, primaryAb, primaryBa),
			fallback: scoreJevOrder(jevPairs, fallbackAb, fallbackBa),
		},
		jevAt060: {
			primary: precisionAt(jevPairs, primaryAb, 0.6),
			fallback: precisionAt(jevPairs, fallbackAb, 0.6),
		},
	};
	const verdict = judge(scores);
	const failures = [...verdict.failures];

	const approvals = [parserSet.approved_by_owner, jevSet.approved_by_owner];
	const approvedByOwner = approvals.every((d) => d !== null)
		? ([...(approvals as string[])].sort().at(-1) as string)
		: null;
	if (approvedByOwner === null) {
		failures.push("ゴールドセットがオーナーの承認を受けていません");
	}

	return {
		ranAt,
		passed: failures.length === 0,
		failures,
		scores,
		reference: {
			latencyP95Ms: {
				parser: p95(parserProbe.latencies),
				jevPrimary: p95(primaryProbe.latencies),
				jevFallback: p95(fallbackProbe.latencies),
			},
			inputTokensMean: {
				parser: mean(parserProbe.inputTokens),
				jevFallback: mean(fallbackProbe.inputTokens),
			},
		},
		models: {
			anthropic: ANTHROPIC_MODEL,
			typesafe_requested: TYPESAFE_MODEL,
			typesafe_answered: [...answered].sort(),
		},
		goldset: {
			parserVersion: parserSet.version,
			jevVersion: jevSet.version,
			approvedByOwner,
		},
		fingerprint: fp,
		fingerprintArtifacts: fpArtifacts,
	};
};

const rateText = (r: { correct: number; n: number }): string =>
	r.n === 0
		? "採点なし"
		: `${((r.correct / r.n) * 100).toFixed(1)}%(${r.correct}/${r.n})`;

const numText = (v: number | null, digits = 3): string =>
	v === null ? "なし" : v.toFixed(digits);

/** 人が読む要約(標準出力用)。キー・URLは含めない */
export const formatSummary = (r: GateRecord): string => {
	const p = r.scores.parser;
	const j = r.scores.jev;
	const lines = [
		`精度ゲートの採点: ${r.passed ? "合格" : "不合格"}(${r.ranAt})`,
		"",
		"Parser:",
		...(
			[
				"form",
				"topic",
				"category",
				"time_start",
				"participants",
				"budget",
				"geo_warning",
			] as const
		).map((f) => `  ${f}: ${rateText(p[f])}`),
		`  alcohol: recall ${numText(p.alcohol.recall)}・precision ${numText(p.alcohol.precision)}`,
		`  呼び出しの失敗: ${p.failedCalls}件`,
		"Jev順序整合(差の中央値):",
		`  第一候補TypeSafe: ${numText(j.primary.median)}(失敗 ${j.primary.failedCalls}/${j.primary.totalCalls})`,
		`  予備Anthropic: ${numText(j.fallback.median)}(失敗 ${j.fallback.failedCalls}/${j.fallback.totalCalls})`,
		"JevのRecall@0.60(正解yesのうち0.60を超えた割合):",
		`  第一候補TypeSafe: ${numText(r.scores.jevAt060.primary.recall)}(${r.scores.jevAt060.primary.truePositive}/${r.scores.jevAt060.primary.actualPositive})`,
		`  予備Anthropic: ${numText(r.scores.jevAt060.fallback.recall)}(${r.scores.jevAt060.fallback.truePositive}/${r.scores.jevAt060.fallback.actualPositive})`,
		"参考値:",
		`  Precision@0.60: 第一候補 ${numText(r.scores.jevAt060.primary.precision)}・予備 ${numText(r.scores.jevAt060.fallback.precision)}`,
		`  応答時間p95(ミリ秒): Parser ${numText(r.reference.latencyP95Ms.parser, 0)}・Jev第一候補 ${numText(r.reference.latencyP95Ms.jevPrimary, 0)}・Jev予備 ${numText(r.reference.latencyP95Ms.jevFallback, 0)}`,
		`モデル: Anthropic ${r.models.anthropic}・TypeSafe ${r.models.typesafe_requested}(応答 ${r.models.typesafe_answered.join(", ") || "なし"})`,
	];
	if (r.failures.length > 0) {
		lines.push("", "不合格の理由:", ...r.failures.map((f) => `  - ${f}`));
	}
	return `${lines.join("\n")}\n`;
};
