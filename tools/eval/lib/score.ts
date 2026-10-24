/**
 * 精度ゲートの採点(設計書 §0.4・§3.3・docs/07 §6)。純関数だけを置き、呼び出しはgate.tsが行う。
 * 期待値の意味はeval/goldset/README.md(キーを書かない=採点しない・null=無いことを期待)。
 */
import { LATCH } from "@latch/shared";
import {
	JEV_AXES,
	type JevAxes,
	type JevAxis,
	type JevOutcome,
	type LlmFailureKind,
	type ParserOutcome,
	type ParserOutput,
} from "../../../apps/worker/src/llm/types";
import type { JevPair, ParserItem } from "./goldset";

// ---- Parser ----

/** 一致率。n=採点した件数・rateはn=0のときnull */
export type Rate = { correct: number; n: number; rate: number | null };

export type AlcoholScore = {
	n: number;
	tp: number;
	fp: number;
	fn: number;
	/** tp/(tp+fn)。正例が無ければnull */
	recall: number | null;
	/** tp/(tp+fp)。正と出した件が無ければnull */
	precision: number | null;
};

/** 失敗の内訳(調整のため件のidと項目だけを持つ。応答の本文は持たない) */
export type ItemFailure =
	| { id: string; field: Exclude<ParserField, "call"> }
	| { id: string; field: "call"; kind: LlmFailureKind };

type ParserField =
	| "form"
	| "topic"
	| "category"
	| "time_start"
	| "participants"
	| "budget"
	| "geo_warning"
	| "alcohol_involved"
	| "call";

type RateField = Exclude<ParserField, "alcohol_involved" | "call">;

export type ParserScores = Record<RateField, Rate> & {
	alcohol: AlcoholScore;
	failedCalls: number;
	failures: ItemFailure[];
};

/** 主題語の比較用の正規化(全角半角の揺れと英字の大小を寄せる) */
const norm = (s: string): string => s.normalize("NFKC").toLowerCase();

const topicMatches = (expect: ParserItem["expect"], topic: string): boolean => {
	const words =
		expect.topic !== undefined ? [expect.topic] : (expect.topic_any ?? []);
	return words.some((w) => norm(topic).includes(norm(w)));
};

/** 項目ごとの一致の判定。期待値のキーが無い項目はundefined(採点しない) */
const judgeFields = (
	expect: ParserItem["expect"],
	out: ParserOutput,
): Partial<Record<RateField, boolean>> => {
	const r: Partial<Record<RateField, boolean>> = {};
	if (expect.form !== undefined) r.form = out.form === expect.form;
	if (expect.topic !== undefined || expect.topic_any !== undefined) {
		r.topic = topicMatches(expect, out.topic);
	}
	if (expect.category !== undefined)
		r.category = out.category === expect.category;
	if (expect.time_start !== undefined) {
		r.time_start =
			expect.time_start === null
				? out.time === null
				: out.time !== null &&
					Date.parse(out.time.start) === Date.parse(expect.time_start);
	}
	if (expect.participants !== undefined) {
		r.participants =
			out.participants.min === expect.participants.min &&
			out.participants.max === expect.participants.max;
	}
	if (expect.budget !== undefined) {
		const e = expect.budget;
		// 片側がnullの期待値はその側を採点しない(出力の予算は両側とも数値のため)
		r.budget =
			e === null
				? out.budget === null
				: out.budget !== null &&
					(e.min === null || out.budget.min === e.min) &&
					(e.max === null || out.budget.max === e.max);
	}
	if (expect.geo_warning !== undefined) {
		r.geo_warning =
			out.warnings.some((w) => w.field === "geo") === expect.geo_warning;
	}
	return r;
};

const RATE_FIELDS: RateField[] = [
	"form",
	"topic",
	"category",
	"time_start",
	"participants",
	"budget",
	"geo_warning",
];

/** 期待値が採点する項目(呼び出しの失敗のときに不一致として数える対象) */
const scoredFields = (expect: ParserItem["expect"]): RateField[] =>
	RATE_FIELDS.filter((f) =>
		f === "topic"
			? expect.topic !== undefined || expect.topic_any !== undefined
			: expect[f] !== undefined,
	);

const toRate = (correct: number, n: number): Rate => ({
	correct,
	n,
	rate: n === 0 ? null : correct / n,
});

/**
 * Parserの採点。outcomesはitemsと同じ順。呼び出しの失敗は、その件が採点する
 * すべての項目で不一致として数える(失敗の内訳にはfield "call"の1行だけを残す)
 */
export const scoreParser = (
	items: ParserItem[],
	outcomes: ParserOutcome[],
): ParserScores => {
	if (items.length !== outcomes.length) {
		throw new Error("ゴールドセットの件数と結果の数が違います");
	}
	const counts = Object.fromEntries(
		RATE_FIELDS.map((f) => [f, { correct: 0, n: 0 }]),
	) as Record<RateField, { correct: number; n: number }>;
	const alcohol = { n: 0, tp: 0, fp: 0, fn: 0 };
	const failures: ItemFailure[] = [];
	let failedCalls = 0;

	items.forEach((item, i) => {
		const outcome = outcomes[i] as ParserOutcome;
		const e = item.expect;
		if (!outcome.ok) {
			failedCalls++;
			failures.push({ id: item.id, field: "call", kind: outcome.kind });
			for (const f of scoredFields(e)) counts[f].n++;
			if (e.alcohol_involved !== undefined) {
				alcohol.n++;
				if (e.alcohol_involved) alcohol.fn++;
			}
			return;
		}
		const judged = judgeFields(e, outcome.output);
		for (const f of RATE_FIELDS) {
			const hit = judged[f];
			if (hit === undefined) continue;
			counts[f].n++;
			if (hit) counts[f].correct++;
			else failures.push({ id: item.id, field: f });
		}
		if (e.alcohol_involved !== undefined) {
			alcohol.n++;
			const got = outcome.output.alcohol_involved;
			if (e.alcohol_involved && got) alcohol.tp++;
			else if (e.alcohol_involved) alcohol.fn++;
			else if (got) alcohol.fp++;
			if (got !== e.alcohol_involved) {
				failures.push({ id: item.id, field: "alcohol_involved" });
			}
		}
	});

	const rates = Object.fromEntries(
		RATE_FIELDS.map((f) => [f, toRate(counts[f].correct, counts[f].n)]),
	) as Record<RateField, Rate>;
	return {
		...rates,
		alcohol: {
			...alcohol,
			recall:
				alcohol.tp + alcohol.fn === 0
					? null
					: alcohol.tp / (alcohol.tp + alcohol.fn),
			precision:
				alcohol.tp + alcohol.fp === 0
					? null
					: alcohol.tp / (alcohol.tp + alcohol.fp),
		},
		failedCalls,
		failures,
	};
};

// ---- Jev ----

export type JevOrderScore = {
	/** 差の絶対値の中央値。有効な組が無ければnull */
	median: number | null;
	/** 中央値を取った差の個数(有効な組×7軸) */
	n: number;
	/** 失敗した呼び出しの数と総数((A,B)・(B,A)の両方を数える) */
	failedCalls: number;
	totalCalls: number;
	/** どちらかの順が失敗して除いた組のid */
	failedPairs: string[];
};

/** (A,B)の軸 → 同じ意味の(B,A)の軸。acceptの2軸は主語が入れ替わる */
const SWAPPED: Record<JevAxis, JevAxis> = {
	would_a_accept_b: "would_b_accept_a",
	would_b_accept_a: "would_a_accept_b",
	purpose_fit: "purpose_fit",
	mood_fit: "mood_fit",
	timing_fit: "timing_fit",
	social_fit: "social_fit",
	latent_yes: "latent_yes",
};

const median = (xs: number[]): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/**
 * Jevの順序整合(設計書 §0.4)。同じ組を(A,B)・(B,A)の順で送った結果の、意味の同じ軸どうしの
 * 差の絶対値を全軸・全組で集めた中央値。どちらかの順が失敗した組は除く
 * (失敗が多すぎる場合の不合格はjudgeで扱う)
 */
export const scoreJevOrder = (
	pairs: JevPair[],
	ab: JevOutcome[],
	ba: JevOutcome[],
): JevOrderScore => {
	if (pairs.length !== ab.length || pairs.length !== ba.length) {
		throw new Error("ゴールドセットの組の数と結果の数が違います");
	}
	const diffs: number[] = [];
	const failedPairs: string[] = [];
	let failedCalls = 0;
	pairs.forEach((pair, i) => {
		const x = ab[i] as JevOutcome;
		const y = ba[i] as JevOutcome;
		if (!x.ok) failedCalls++;
		if (!y.ok) failedCalls++;
		if (!x.ok || !y.ok) {
			failedPairs.push(pair.id);
			return;
		}
		for (const axis of JEV_AXES) {
			diffs.push(Math.abs(x.axes[axis] - y.axes[SWAPPED[axis]]));
		}
	});
	return {
		median: median(diffs),
		n: diffs.length,
		failedCalls,
		totalCalls: pairs.length * 2,
		failedPairs,
	};
};

export type PrecisionAt = {
	threshold: number;
	/** 閾値を超えた組のうち正解yesの割合。超えた組が無ければnull */
	precision: number | null;
	predictedPositive: number;
	truePositive: number;
	/** 採点できた組の数(失敗を除く) */
	n: number;
	failedCalls: number;
};

/**
 * LATCH Score(docs/06 §6・apps/worker/src/pipeline/layer5.tsのlatchScoreと同じ式)。
 * ゴールドセットの組はHard Constraintを前提にしないためh=1とする。
 * layer5.tsはD1の部品を読み込むためNodeの採点から直接importせず、式と定数(@latch/shared)を揃える
 */
const latchScore = (axes: JevAxes): number =>
	Math.min(axes.would_a_accept_b, axes.would_b_accept_a) * LATCH.CALIBRATION_C;

/** Offline Precision@閾値(docs/09 §4)。参考値で合否には使わない。超えるの判定はLayer 5と同じ「>」 */
export const precisionAt = (
	pairs: JevPair[],
	outcomes: JevOutcome[],
	threshold: number,
): PrecisionAt => {
	if (pairs.length !== outcomes.length) {
		throw new Error("ゴールドセットの組の数と結果の数が違います");
	}
	let n = 0;
	let predictedPositive = 0;
	let truePositive = 0;
	let failedCalls = 0;
	pairs.forEach((pair, i) => {
		const o = outcomes[i] as JevOutcome;
		if (!o.ok) {
			failedCalls++;
			return;
		}
		n++;
		if (latchScore(o.axes) > threshold) {
			predictedPositive++;
			if (pair.match === "yes") truePositive++;
		}
	});
	return {
		threshold,
		precision:
			predictedPositive === 0 ? null : truePositive / predictedPositive,
		predictedPositive,
		truePositive,
		n,
		failedCalls,
	};
};

// ---- 合否 ----

export type GateScores = {
	parser: ParserScores;
	jev: { primary: JevOrderScore; fallback: JevOrderScore };
};

/** 合格基準(設計書 §3.3・百分率の整数で持ち、境界は「以上」を整数演算で判定する) */
export const CRITERIA = {
	form: 90,
	topic: 85,
	category: 85,
	time_start: 90,
	participants: 80,
	budget: 90,
	geo_warning: 90,
	alcoholRecall: 100,
	alcoholPrecision: 90,
	/** Jev順序整合の中央値の上限(以下で合格) */
	jevOrderMedian: 0.3,
	/** Jevの呼び出しの失敗の割合の上限(百分率・これを超えると不合格) */
	jevFailedCallsPct: 10,
} as const;

const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

/** 合否の判定。不合格の理由を日本語で並べる */
export const judge = (
	scores: GateScores,
): { passed: boolean; failures: string[] } => {
	const failures: string[] = [];
	const p = scores.parser;
	for (const f of RATE_FIELDS) {
		const r = p[f];
		const need = CRITERIA[f];
		if (r.n === 0) {
			failures.push(`${f}: 採点できる件がありません(基準${need}%以上)`);
		} else if (r.correct * 100 < need * r.n) {
			failures.push(
				`${f}: ${pct(r.correct / r.n)}(${r.correct}/${r.n})が基準${need}%以上を満たしません`,
			);
		}
	}
	const a = p.alcohol;
	const ratio = (num: number, den: number, need: number, name: string) => {
		if (den === 0) {
			failures.push(
				`alcohol ${name}: 採点できる件がありません(基準${need}%以上)`,
			);
		} else if (num * 100 < need * den) {
			failures.push(
				`alcohol ${name}: ${pct(num / den)}(${num}/${den})が基準${need}%以上を満たしません`,
			);
		}
	};
	ratio(a.tp, a.tp + a.fn, CRITERIA.alcoholRecall, "recall");
	ratio(a.tp, a.tp + a.fp, CRITERIA.alcoholPrecision, "precision");

	const jev = (s: JevOrderScore, name: string) => {
		if (s.failedCalls * 100 > CRITERIA.jevFailedCallsPct * s.totalCalls) {
			failures.push(
				`Jev順序整合(${name}): 呼び出しの失敗が${s.failedCalls}/${s.totalCalls}件で${CRITERIA.jevFailedCallsPct}%を超えます`,
			);
		} else if (s.median === null) {
			failures.push(`Jev順序整合(${name}): 有効な組が無く中央値を出せません`);
		} else if (s.median > CRITERIA.jevOrderMedian) {
			failures.push(
				`Jev順序整合(${name}): 中央値${s.median.toFixed(3)}が基準${CRITERIA.jevOrderMedian}以下を満たしません`,
			);
		}
	};
	jev(scores.jev.primary, "第一候補TypeSafe");
	jev(scores.jev.fallback, "予備Anthropic");
	return { passed: failures.length === 0, failures };
};
