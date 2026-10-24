/**
 * Layer 1 Hard Filter(docs/06 §3・コード+D1 — AI不使用)。
 *
 * - layer1Judge: 取り出した候補と起点Intentの組ごとに表の10規則をコードで判定する
 *   純関数。出力はpass/failのみで、不合格のときは最初に一致した理由を1つ返す。
 *   現在時刻は呼び出し側が渡す(docs/04 §4の時刻の規律)
 * - fetchL1Data: 判定に要するD1データ(候補Intent行・users.birth_date・blocks・
 *   proposal_history)を100件チャンクのin句で一括取得する。Vectorize metadataには
 *   依存せずstatus・ブロック・履歴はD1の現行値で再検証する(二重化)
 */
import { PIPELINE } from "@latch/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { ageAtYears } from "../auth/age";
import { blocks, intents, proposalHistory, users } from "../db/schema";

/** intents行の型(db/schemaの$inferSelect) */
type IntentRow = typeof intents.$inferSelect;

/** Layer 1の不合格理由(docs/06 §3の表の判定+fail-close) */
export type L1ExclusionReason =
	| "form_mismatch"
	| "status_inactive"
	| "self_pair"
	| "blocked"
	| "proposal_history"
	| "alcohol_under_age"
	| "time_no_overlap"
	| "geo_no_overlap"
	| "participants_no_overlap"
	| "budget_no_overlap"
	| "missing_intent_row";

/** layer1Judgeの出力。pass/failのみで、failのときだけ理由を載せる */
export interface L1Judgement {
	pass: boolean;
	reason?: L1ExclusionReason;
}

/** 飲酒を伴う機会Intentに必要な満年齢(docs/06 §3・08 §8。作成時の18歳検証とは別値) */
export const LEGAL_DRINKING_AGE = 20;

/** D1照会のチャンク幅(100件・docs/06 §3) */
const CHUNK_SIZE = 100;

/**
 * ペア照会(blocks・proposal_history)のチャンク幅。orの両分岐それぞれに
 * in句+起点ユーザーのeqが付く(blocks=2×チャンク+2・proposal_historyは
 * さらにoutcome in 2つで2×チャンク+4)ため、合計バインド数が
 * D1の上限100内に収まる値
 */
const PAIR_CHUNK_SIZE = 48;

/** 地球半径(メートル)。ハバーシン距離の計算に使う */
const EARTH_RADIUS_M = 6_371_000;

/** 度→ラジアン */
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * ユーザーペアの正規化キー(low:high・常に辞書順で低い方を先に)。
 * blocks・proposal_historyのペア照合に使う
 */
export const pairKey = (userA: string, userB: string): string =>
	userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;

/** 不合格結果を作る(表の順序で最初に一致した理由を1つ) */
const fail = (reason: L1ExclusionReason): L1Judgement => ({
	pass: false,
	reason,
});

/** geo3点(lat/lng/radius)が揃っている場合のみ値を返す(片方のみ・未添付はnull) */
const geoOf = (
	intent: IntentRow,
): { lat: number; lng: number; radiusM: number } | null =>
	intent.geoCenterLat !== null &&
	intent.geoCenterLng !== null &&
	intent.geoRadiusM !== null
		? {
				lat: intent.geoCenterLat,
				lng: intent.geoCenterLng,
				radiusM: intent.geoRadiusM,
			}
		: null;

/**
 * 機会Intent同士の時間重なり(ミリ秒)。判定不能のときnull(本層では不合格にしない・
 * docs/06 §3「判定データを欠くNG条件は扱わない」)。
 * 終端はends_atを優先し無効ならexpires_at(docs/05 §2.2「ends_at=nullはexpires_atを
 * 終端とみなす」)。starts_atは機会Intentでは非nullが前提だが、nullなら判定不能とする
 */
const timeOverlapMs = (a: IntentRow, b: IntentRow): number | null => {
	if (a.startsAt === null || b.startsAt === null) {
		return null;
	}
	const endA = a.endsAt ?? a.expiresAt;
	const endB = b.endsAt ?? b.expiresAt;
	if (endA === null || endB === null) {
		return null;
	}
	return (
		Math.min(endA.getTime(), endB.getTime()) -
		Math.max(a.startsAt.getTime(), b.startsAt.getTime())
	);
};

/** 中心間のハバーシン距離(メートル)。度→ラジアン変換の標準式・地球半径6371km */
export const haversineM = (
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number => {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * 地域の重なり(中心間距離 ≤ 半径の和)。bbox事前絞りを先に行い、範囲外なら
 * ハバーシンを計算しない(docs/06 §3「bbox事前絞り+中心間距離 ≤ 半径の和」)。
 * 経度の度境界は緯度の余弦で縮むため、両者の緯度のうち余弦が小さい方(広い境界)を
 * 採って事前絞りが真の不合格を取りこぼさないようにする
 */
const geoOverlaps = (
	a: { lat: number; lng: number; radiusM: number },
	b: { lat: number; lng: number; radiusM: number },
): boolean => {
	const radiusSumM = a.radiusM + b.radiusM;
	// 半径の和に相当する緯度の度幅(1度=地球周長の360分の1)
	const maxLatDeg = radiusSumM * (180 / (Math.PI * EARTH_RADIUS_M));
	if (Math.abs(a.lat - b.lat) > maxLatDeg) {
		return false;
	}
	const cosMin = Math.min(
		Math.abs(Math.cos(toRad(a.lat))),
		Math.abs(Math.cos(toRad(b.lat))),
	);
	// 極域(余弦≈0)では経度の度境界が発散するため事前絞りをせずハバーシンに委ねる
	if (cosMin > 1e-6 && Math.abs(a.lng - b.lng) > maxLatDeg / cosMin) {
		return false;
	}
	return haversineM(a, b) <= radiusSumM;
};

/**
 * Layer 1の判定(docs/06 §3の表・上からの順序)。最初に一致した不合格理由を
 * 1つ返す。candidate=null(照会時にD1行が存在しない)はfail-closeで除外する。
 * birthDatesはuserId→'YYYY-MM-DD'(飲酒年齢の判定に使い・欠落はfail-close)
 */
export const layer1Judge = (
	origin: IntentRow,
	candidate: IntentRow | null,
	birthDates: Record<string, string>,
	blocked: boolean,
	hasHistory: boolean,
	now: Date,
): L1Judgement => {
	// 候補のD1行不在はfail-close(docs/06 §3)
	if (candidate === null) {
		return fail("missing_intent_row");
	}
	// form一致(つながり×機会は絶対不合格)
	if (origin.form !== candidate.form) {
		return fail("form_mismatch");
	}
	// status(双方active・D1現行値で再検証)
	if (origin.status !== "active" || candidate.status !== "active") {
		return fail("status_inactive");
	}
	// 自己ペア(user_id一致)
	if (origin.userId === candidate.userId) {
		return fail("self_pair");
	}
	// ブロック(いずれかの方向のblocks行の存在)
	if (blocked) {
		return fail("blocked");
	}
	// 提案履歴(恒久排除・docs/01 §8。deferred/expiredは渡さない)
	if (hasHistory) {
		return fail("proposal_history");
	}
	// 飲酒年齢(組のいずれかがalcohol_involved=trueなら判定時点で両者満20歳・docs/08 §8)
	if (origin.alcoholInvolved || candidate.alcoholInvolved) {
		const originBirth = birthDates[origin.userId];
		const candidateBirth = birthDates[candidate.userId];
		// birth_date欠落はfail-close(年齢は安全性要件のため欠落=不合格に倒す)
		if (originBirth === undefined || candidateBirth === undefined) {
			return fail("alcohol_under_age");
		}
		if (
			ageAtYears(now, originBirth) < LEGAL_DRINKING_AGE ||
			ageAtYears(now, candidateBirth) < LEGAL_DRINKING_AGE
		) {
			return fail("alcohol_under_age");
		}
	}
	// 時間(機会のみ・重なり15分以上)
	if (origin.form === "occasion" && candidate.form === "occasion") {
		const overlapMs = timeOverlapMs(origin, candidate);
		if (overlapMs !== null && overlapMs < PIPELINE.TIME_OVERLAP_MIN_MS) {
			return fail("time_no_overlap");
		}
	}
	// 地域(両方添付時のみ・片方のみ/双方未添付は全国スコープで判定しない・docs/01 §12)
	const originGeo = geoOf(origin);
	const candidateGeo = geoOf(candidate);
	if (
		originGeo !== null &&
		candidateGeo !== null &&
		!geoOverlaps(originGeo, candidateGeo)
	) {
		return fail("geo_no_overlap");
	}
	// 人数(participants区間の共通部分)
	if (
		origin.participantsMax < candidate.participantsMin ||
		candidate.participantsMax < origin.participantsMin
	) {
		return fail("participants_no_overlap");
	}
	// 予算(機会のみ・両方min/max設定時のみ・区間の共通部分)
	if (origin.form === "occasion" && candidate.form === "occasion") {
		if (
			origin.budgetMin !== null &&
			origin.budgetMax !== null &&
			candidate.budgetMin !== null &&
			candidate.budgetMax !== null &&
			(origin.budgetMax < candidate.budgetMin ||
				candidate.budgetMax < origin.budgetMin)
		) {
			return fail("budget_no_overlap");
		}
	}
	return { pass: true };
};

/** Layer 1の判定に要するD1データ(docs/06 §3) */
export interface L1Data {
	/** 候補Intent行(存在しない候補IDはキーごと欠落=layer1Judgeでfail-close) */
	intents: Record<string, IntentRow>;
	/** userId→birth_date('YYYY-MM-DD')。起点ユーザー分を含む */
	birthDates: Record<string, string>;
	/** 起点↔候補ユーザーのblocks(pairKey正規化・両方向を1キーにまとめる) */
	blockedPairs: Set<string>;
	/** 起点↔候補ユーザーのproposal_history(pairKey正規化・outcome=matched|rejectedのみ) */
	historyPairs: Set<string>;
}

/** in句に渡すID列を指定幅のチャンクに分割する(docs/06 §3の100件チャンク) */
const chunksOf = (ids: string[], size: number): string[][] => {
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += size) {
		chunks.push(ids.slice(i, i + size));
	}
	return chunks;
};

/** 候補Intent行の読み込み(100件チャンクのin句を同時に投げる)。重複IDは1行にまとめる */
export const fetchIntentRows = async (
	db: DrizzleD1Database,
	ids: string[],
): Promise<IntentRow[]> => {
	const chunks = await Promise.all(
		chunksOf([...new Set(ids)], CHUNK_SIZE).map((chunk) =>
			db.select().from(intents).where(inArray(intents.id, chunk)),
		),
	);
	return chunks.flat();
};

/**
 * 候補Intent行を読んだ後の判定データ(users・blocks・proposal_history)。
 * 3表とも候補行のuser_idだけに依存し互いに依存しないため、全チャンクを同時に投げる
 * (D1の直列の待ちを1段にする・#36)
 */
export const fetchL1DataForRows = async (
	db: DrizzleD1Database,
	originUserId: string,
	intentRows: IntentRow[],
): Promise<L1Data> => {
	const intentsRecord: Record<string, IntentRow> = Object.fromEntries(
		intentRows.map((row) => [row.id, row]),
	);

	// users.birth_date(飲酒年齢の判定は起点・候補の両者分が必要)
	const userIds = [
		...new Set([originUserId, ...intentRows.map((r) => r.userId)]),
	];
	const userReads = chunksOf(userIds, CHUNK_SIZE).map((chunk) =>
		db
			.select({ id: users.id, birthDate: users.birthDate })
			.from(users)
			.where(inArray(users.id, chunk)),
	);

	// blocks(両方向)。起点を含まない組の行は照会しない
	const candidateUserIds = [...new Set(intentRows.map((r) => r.userId))];
	const blockReads = chunksOf(candidateUserIds, PAIR_CHUNK_SIZE).map((chunk) =>
		db
			.select()
			.from(blocks)
			.where(
				or(
					and(
						eq(blocks.blockerUserId, originUserId),
						inArray(blocks.blockedUserId, chunk),
					),
					and(
						inArray(blocks.blockerUserId, chunk),
						eq(blocks.blockedUserId, originUserId),
					),
				),
			),
	);

	// proposal_history(恒久排除はmatched/rejected行の存在のみ・docs/01 §8)
	const historyReads = chunksOf(candidateUserIds, PAIR_CHUNK_SIZE).map(
		(chunk) =>
			db
				.select()
				.from(proposalHistory)
				.where(
					and(
						inArray(proposalHistory.outcome, ["matched", "rejected"]),
						or(
							and(
								eq(proposalHistory.userLow, originUserId),
								inArray(proposalHistory.userHigh, chunk),
							),
							and(
								eq(proposalHistory.userHigh, originUserId),
								inArray(proposalHistory.userLow, chunk),
							),
						),
					),
				),
	);

	const [userRows, blockRows, historyRows] = await Promise.all([
		Promise.all(userReads),
		Promise.all(blockReads),
		Promise.all(historyReads),
	]);
	const birthDates: Record<string, string> = {};
	for (const row of userRows.flat()) {
		birthDates[row.id] = row.birthDate;
	}
	const blockedPairs = new Set<string>();
	for (const row of blockRows.flat()) {
		blockedPairs.add(pairKey(row.blockerUserId, row.blockedUserId));
	}
	const historyPairs = new Set<string>();
	for (const row of historyRows.flat()) {
		historyPairs.add(pairKey(row.userLow, row.userHigh));
	}

	return { intents: intentsRecord, birthDates, blockedPairs, historyPairs };
};

/**
 * Layer 1の判定データをD1から一括取得する。すべての照会(候補Intent・users・
 * blocks・proposal_history)を100件チャンクで分割発行する(docs/06 §3)。
 * blocks・proposal_historyは起点ユーザー↔候補ユーザーの両方向を照会し、
 * 正規化キー(low:high)のSetにまとめる。候補行の読み込み→残り3表(同時)の2段で読む(#36)
 */
export const fetchL1Data = async (
	db: DrizzleD1Database,
	originUserId: string,
	candidateIds: string[],
): Promise<L1Data> =>
	fetchL1DataForRows(db, originUserId, await fetchIntentRows(db, candidateIds));

/**
 * Poolのメンバー(起点+Pool・最大16人)全員のユーザー間について、Layer 1の判定データを
 * 取得する(F4b設計 §2.2)。起点↔候補だけでなく他人どうしのblocks・proposal_history
 * (matched/rejected)も含む。ユーザーは最大16人のため、各表とも両側in句の1文で足りる
 * (users=16・blocks=16+16=32・proposal_history=2+16+16=34バインド・D1の上限100内)。
 * 戻り値の集合はpairKey(userA, userB)で正規化する
 */
export const fetchMembersL1Data = async (
	db: DrizzleD1Database,
	members: IntentRow[],
): Promise<Omit<L1Data, "intents">> => {
	const userIds = [...new Set(members.map((m) => m.userId))];
	const birthDates: Record<string, string> = {};
	const blockedPairs = new Set<string>();
	const historyPairs = new Set<string>();
	if (userIds.length === 0) {
		return { birthDates, blockedPairs, historyPairs };
	}

	// 3表は互いに依存しないため同時に投げる(D1の直列の待ちを1段にする・#36)
	const [userRows, blockRows, historyRows] = await Promise.all([
		db
			.select({ id: users.id, birthDate: users.birthDate })
			.from(users)
			.where(inArray(users.id, userIds)),
		// blocks(両端がメンバーの行。向きは問わず1キーにまとめる)
		db
			.select()
			.from(blocks)
			.where(
				and(
					inArray(blocks.blockerUserId, userIds),
					inArray(blocks.blockedUserId, userIds),
				),
			),
		// proposal_history(恒久排除はmatched/rejected行の存在のみ・docs/01 §8)
		db
			.select()
			.from(proposalHistory)
			.where(
				and(
					inArray(proposalHistory.outcome, ["matched", "rejected"]),
					inArray(proposalHistory.userLow, userIds),
					inArray(proposalHistory.userHigh, userIds),
				),
			),
	]);
	for (const row of userRows) {
		birthDates[row.id] = row.birthDate;
	}
	for (const row of blockRows) {
		blockedPairs.add(pairKey(row.blockerUserId, row.blockedUserId));
	}
	for (const row of historyRows) {
		historyPairs.add(pairKey(row.userLow, row.userHigh));
	}

	return { birthDates, blockedPairs, historyPairs };
};
