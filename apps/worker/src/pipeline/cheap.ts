/**
 * Layer 3 Cheap Judge(docs/06 §3・LLM不使用・課金ゼロ)の合成スコア。
 *
 * cheapJudgeScore: 1対1候補の事前順位付け用の純関数。
 *   合成スコア = 0.7 × clamp(類似度, 0, 1) + 0.3 × ルール点
 *   ルール点 = (topic一致度 + participants重なり + 地理近接) / 3
 * 重みはD-C-02の暫定値(運用データによるOffline評価で調整)。上位K_c=20の
 * 選別は呼び出し側がPIPELINE.LAYER3_OUTPUT_MAXで担う。LLMをここに使わない
 * 理由はコスト保護3層(docs/04 §5)の実効性を保つため(課金発生はJev・Parser・
 * Embeddingに限る)
 */
import { PARTICIPANTS_MAX, PARTICIPANTS_MIN } from "@latch/shared";

/** 類似度側の合成重み(docs/06 §3・D-C-02暫定値) */
const SIMILARITY_WEIGHT = 0.7;

/** ルール点側の合成重み(docs/06 §3・D-C-02暫定値) */
const RULE_WEIGHT = 0.3;

/** 地理近接の飽和距離(m)。この距離以上で近接0(docs/06 §3) */
const GEO_SATURATION_M = 100_000;

/** 値を0..1へ切り詰める */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * 文字2-gramの集合(文字単位・stride 1・重複はまとめる)。長さ2未満の文字列は
 * 文字集合に代替する。文字の分解はスプレッド(Unicodeコードポイント単位)で
 * 行い、topicはdocs/05 §2.2の40字上限の日本語主体の文字列という前提に置く
 */
const charBigrams = (text: string): Set<string> => {
	const chars = [...text];
	if (chars.length < 2) {
		return new Set(chars);
	}
	const grams = new Set<string>();
	for (let i = 0; i < chars.length - 1; i++) {
		grams.add(chars[i] + chars[i + 1]);
	}
	return grams;
};

/**
 * 2集合のJaccard係数(|A∩B| / |A∪B|)。双方空(同一の空文字列)は同一扱いで
 * 1・片方のみ空なら交差0で0
 */
const jaccard = (a: Set<string>, b: Set<string>): number => {
	let intersection = 0;
	for (const gram of a) {
		if (b.has(gram)) {
			intersection++;
		}
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 1 : intersection / union;
};

/**
 * participants区間の重なり。共通幅 max(0, min(maxA, maxB) − max(minA, minB) + 1)
 * を区間幅の最大値(PARTICIPANTS_MAX − PARTICIPANTS_MIN + 1)で割り0..1へclamp
 * (全離散で0・区間一致で1)
 */
const participantsOverlap = (
	a: { min: number; max: number },
	b: { min: number; max: number },
): number => {
	const width = Math.max(
		0,
		Math.min(a.max, b.max) - Math.max(a.min, b.min) + 1,
	);
	return clamp01(width / (PARTICIPANTS_MAX - PARTICIPANTS_MIN + 1));
};

/**
 * 地理近接。双方添付(geoDistanceM≠null)時は 1 − min(1, 距離m / 飽和距離)
 * (同地点で1・100km以上で0)。片方・両方未添付は中立0.5(docs/06 §3の
 * 「未添付は中立値」・地理判定自体はLayer 1が両方添付時のみに行う)
 */
const geoProximity = (geoDistanceM: number | null): number => {
	if (geoDistanceM === null) {
		return 0.5;
	}
	return 1 - Math.min(1, geoDistanceM / GEO_SATURATION_M);
};

/** cheapJudgeScoreの入力(起点Intentと1対1候補の組ごとの値) */
export interface CheapJudgeInput {
	/** 正規化類似度(Layer 2のベクトルから得た値。範囲外は0..1へclamp) */
	similarity: number;
	/** 起点Intentのtopic(docs/05 §2.2・draftでは未確定nullだが確定後を渡す) */
	topicA: string;
	/** 候補Intentのtopic */
	topicB: string;
	/** 起点Intentのparticipants区間(2〜4) */
	participantsA: { min: number; max: number };
	/** 候補Intentのparticipants区間(2〜4) */
	participantsB: { min: number; max: number };
	/** 中心間距離(m)。片方・両方の地理未添付はnull */
	geoDistanceM: number | null;
}

/**
 * Layer 3の合成スコア(docs/06 §3)を返す。0..1の範囲で同一入力に対し常に
 * 同一値を返す決定的な純関数(時刻・乱数・外部I/Oに依存しない)
 */
export const cheapJudgeScore = (input: CheapJudgeInput): number => {
	const topicScore = jaccard(
		charBigrams(input.topicA),
		charBigrams(input.topicB),
	);
	const participantsScore = participantsOverlap(
		input.participantsA,
		input.participantsB,
	);
	const geoScore = geoProximity(input.geoDistanceM);
	// 3要素の等分(docs/06 §3・D-C-02暫定値)
	const ruleScore = (topicScore + participantsScore + geoScore) / 3;
	return (
		SIMILARITY_WEIGHT * clamp01(input.similarity) + RULE_WEIGHT * ruleScore
	);
};
