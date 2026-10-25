/**
 * グループLATCHの評価(F4b設計 §2.2〜§2.5)のうち、D1・VectorStoreに触れる部分。
 *
 * - prepareGroups: Pool構築 → Pool内の全ペアのHard判定 → 集合の列挙 →
 *   集合に現れるペアのmatch_candidates行のupsert(既存のjev_resultを返す)
 * - finishGroups: Jev後の集合の点数(aggregate)→ group_candidatesのupsert →
 *   提案直前の再検証 → 1回の評価で1集合だけ提案化
 *
 * 純関数(Pool選定・列挙・配分・点数)はgroup.tsが担う。
 */
import { inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { groupCandidates, type matchCandidates } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import { historyBlockedPairs, proposeSet } from "../latches/propose";
import type { JevAxes } from "../llm/types";
import { createVectorStore } from "../vectorstore";
import { upsertCandidateRows } from "./candidates";
import { cheapJudgeScore, geoDistanceM } from "./cheap";
import type { IntentRow } from "./consumer";
import {
	aggregateOf,
	cosineSimilarity,
	dedupKeyOf,
	enumerateSets,
	type GroupSet,
	intentPairKey,
	type PoolEntry,
	rankByAggregate,
	selectPool,
} from "./group";
import { fetchMembersL1Data, layer1Judge, pairKey } from "./layer1";
import { latchScore, recheckSet } from "./layer5";

/** group_candidatesのupsertの分割幅(7列×12行=84バインド・D1の上限100対策) */
const GROUP_UPSERT_CHUNK_SIZE = 12;

/** group_candidatesの読み直しの分割幅(dedup_keyのin句・docs/06 §3の48件) */
const GROUP_READ_CHUNK_SIZE = 48;

/** prepareGroupsの結果 */
export interface GroupPrep {
	sets: GroupSet[];
	/** intentPairKey → match_candidates行(集合に現れるペアのみ) */
	rows: Map<
		string,
		{ id: string; jevResult: JevAxes | null; a: IntentRow; b: IntentRow }
	>;
	poolSize: number;
}

/**
 * グループ評価の準備(F4b設計 §2.2〜§2.4)。Poolが2件未満(起点が3人以上を許さない・
 * 対象の候補が足りない・ベクトルの無い候補を除いて足りない)ならnull。
 * ベクトルの無い候補(埋め込み未完了・削除済み)は他人どうしの類似度を出せないため
 * Poolから外す。集合が1件も無くてもnullにはせず、空のsetsを返す
 */
export const prepareGroups = async (
	env: Env,
	db: DrizzleD1Database,
	origin: IntentRow,
	entries: PoolEntry[],
	now: Date,
): Promise<GroupPrep | null> => {
	// active化済みIntentのformは非null(evaluate.tsと同じ到達しない防御)
	const form = origin.form;
	const selected = selectPool(origin, entries);
	if (form === null || selected.length < 2) {
		return null;
	}
	// 他人どうしの類似度はPool全員のベクトルのコサイン(F4b設計 §2.2)。
	// 起点ペアの類似度はentries(Layer 2の値)を使うため起点のベクトルは不要
	const vectors = await createVectorStore(env).getByIds(
		selected.map((e) => e.intent.id),
	);
	const valuesById = new Map<string, number[]>();
	const pool: PoolEntry[] = [];
	for (const [i, entry] of selected.entries()) {
		const vector = vectors[i];
		if (vector === null || vector === undefined) {
			continue;
		}
		valuesById.set(entry.intent.id, vector.values);
		pool.push(entry);
	}
	if (pool.length < 2) {
		return null;
	}
	const entryById = new Map(pool.map((e) => [e.intent.id, e]));
	const members = [origin, ...pool.map((e) => e.intent)];

	// Pool内の全ペアのHard判定(F4b設計 §2.2): Layer 1と同じ判定(他人どうしの
	// ブロック・恒久排除を含む)と、提案履歴により今は提案できないペアの除外
	// 2つの読み込みは互いに依存しないため同時に投げる(#36)
	const [l1, historyBlocked] = await Promise.all([
		fetchMembersL1Data(db, members),
		historyBlockedPairs(db, members, now),
	]);
	const pairOk = (a: IntentRow, b: IntentRow): boolean => {
		if (historyBlocked.has(intentPairKey(a.id, b.id))) {
			return false;
		}
		const users = pairKey(a.userId, b.userId);
		return layer1Judge(
			a,
			b,
			l1.birthDates,
			l1.blockedPairs.has(users),
			l1.historyPairs.has(users),
			now,
		).pass;
	};

	// 類似度: 起点ペアはentries・他人どうしはコサイン
	const similarityOf = (a: IntentRow, b: IntentRow): number => {
		if (a.id === origin.id || b.id === origin.id) {
			const other = a.id === origin.id ? b : a;
			return entryById.get(other.id)?.similarity ?? 0;
		}
		const va = valuesById.get(a.id);
		const vb = valuesById.get(b.id);
		return va === undefined || vb === undefined ? 0 : cosineSimilarity(va, vb);
	};
	// 安価な点数: 起点ペアはentriesのcheapScore・他人どうしはLayer 3と同じ式
	const cheapCache = new Map<string, number>();
	const pairCheap = (a: IntentRow, b: IntentRow): number => {
		if (a.id === origin.id || b.id === origin.id) {
			const other = a.id === origin.id ? b : a;
			return entryById.get(other.id)?.cheapScore ?? 0;
		}
		const key = intentPairKey(a.id, b.id);
		const cached = cheapCache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		// topicはevaluate.tsと同じくnullを空文字へ倒す(activeでは非nullが原則)
		const score = cheapJudgeScore({
			similarity: similarityOf(a, b),
			topicA: a.topic ?? "",
			topicB: b.topic ?? "",
			participantsA: { min: a.participantsMin, max: a.participantsMax },
			participantsB: { min: b.participantsMin, max: b.participantsMax },
			geoDistanceM: geoDistanceM(a, b),
		});
		cheapCache.set(key, score);
		return score;
	};

	const sets = enumerateSets(
		origin,
		pool.map((e) => e.intent),
		pairOk,
		pairCheap,
	);

	// 集合に現れるペアだけをupsertする(F4b設計 §2.4の5。除外したペアは行を作らず
	// Jevの枠も使わない・Review Focus 3)
	const pairs = new Map<string, { a: IntentRow; b: IntentRow }>();
	for (const set of sets) {
		for (let i = 0; i < set.members.length; i++) {
			for (let j = i + 1; j < set.members.length; j++) {
				// set.membersはid昇順のため a.id < b.id
				const a = set.members[i];
				const b = set.members[j];
				pairs.set(intentPairKey(a.id, b.id), { a, b });
			}
		}
	}
	const insertRows = [...pairs.values()].map(
		({ a, b }) =>
			({
				id: newUlid(),
				intentAId: a.id,
				intentBId: b.id,
				intentAVersion: a.version,
				intentBVersion: b.version,
				// 同一formはLayer 2/1で保証済み(F4b設計 §2.2)
				form,
				retrievalScore: similarityOf(a, b),
				cheapJudgeScore: pairCheap(a, b),
				status: "candidate",
				createdAt: now,
				updatedAt: now,
			}) satisfies typeof matchCandidates.$inferInsert,
	);
	const saved = await upsertCandidateRows(db, insertRows, now);
	const rows: GroupPrep["rows"] = new Map();
	for (const [key, { a, b }] of pairs) {
		const row = saved.get(key);
		if (row === undefined) {
			// 到達しない(直前のupsertで必ず存在する)・防御
			continue;
		}
		rows.set(key, { ...row, a, b });
	}
	return { sets, rows, poolSize: pool.length };
};

/** finishGroupsの結果(F4b設計 §5の計測) */
export interface GroupOutcome {
	/** aggregateを出してgroup_candidatesへ保存した集合の数 */
	sets: number;
	/** aggregate > 閾値の集合の数 */
	overThreshold: number;
	/** 予定に入れたがJevの判定が欠けてaggregateを出せなかった集合の数(部分評価しない・06 §3) */
	heldSets: number;
	/** 提示した集合の数(0または1) */
	proposed: number;
	/** 通知上限で保留した集合の数(0または1) */
	held: number;
}

/**
 * Jev後の集合の仕上げ(F4b設計 §2.5)。予定に入れた集合のうち全ペアのjev_resultが
 * 揃ったものだけaggregate(全ペアのLATCH Scoreの最小値)を出してgroup_candidatesへ
 * upsertする(dedup_key衝突はaggregate_scoreのみ更新・statusは保持)。閾値超過を
 * aggregate降順に見て、全メンバーの再検証(recheckSet)→proposeSet(group)を行い、
 * proposedまたはheldになった時点で止める(1回の評価で提案する集合は1つだけ)。
 * notifiedAtは提案の通知の行の作成時刻を提案の直前に取る口(LAT-98・省略時はnow)
 */
export const finishGroups = async (
	db: DrizzleD1Database,
	prep: GroupPrep,
	plannedSets: GroupSet[],
	axesByRow: Map<string, JevAxes>,
	now: Date,
	notifiedAt?: () => Date,
): Promise<GroupOutcome> => {
	// ペアごとのLATCH Score(今回の実行分+既存のjev_result・Hは候補化時点で1)
	const scoreByPair = new Map<string, number>();
	for (const [key, row] of prep.rows) {
		const axes = axesByRow.get(row.id) ?? row.jevResult;
		if (axes !== null) {
			scoreByPair.set(key, latchScore(axes, 1));
		}
	}

	let heldSets = 0;
	const scored: (GroupSet & { aggregate: number; dedupKey: string })[] = [];
	for (const set of plannedSets) {
		const aggregate = aggregateOf(set.members, scoreByPair);
		if (aggregate === null) {
			heldSets += 1;
			continue;
		}
		scored.push({ ...set, aggregate, dedupKey: dedupKeyOf(set.members) });
	}

	// group_candidatesへupsertし、dedup_keyで実際の行id(衝突時は既存行)を読み直す
	for (let i = 0; i < scored.length; i += GROUP_UPSERT_CHUNK_SIZE) {
		await db
			.insert(groupCandidates)
			.values(
				scored.slice(i, i + GROUP_UPSERT_CHUNK_SIZE).map((set) => ({
					id: newUlid(),
					intentIds: set.members.map((m) => m.id),
					dedupKey: set.dedupKey,
					aggregateScore: set.aggregate,
					prevAggregateScore: null,
					status: "candidate" as const,
					createdAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: groupCandidates.dedupKey,
				set: { aggregateScore: sql`excluded.aggregate_score` },
			});
	}
	const idByDedupKey = new Map<string, string>();
	for (let i = 0; i < scored.length; i += GROUP_READ_CHUNK_SIZE) {
		const saved = await db
			.select({ id: groupCandidates.id, dedupKey: groupCandidates.dedupKey })
			.from(groupCandidates)
			.where(
				inArray(
					groupCandidates.dedupKey,
					scored.slice(i, i + GROUP_READ_CHUNK_SIZE).map((s) => s.dedupKey),
				),
			);
		for (const row of saved) {
			idByDedupKey.set(row.dedupKey, row.id);
		}
	}

	const ranked = rankByAggregate(scored);
	let proposed = 0;
	let held = 0;
	for (const set of ranked) {
		const groupCandidateId = idByDedupKey.get(set.dedupKey);
		if (groupCandidateId === undefined) {
			// 到達しない(直前のupsertで必ず存在する)・防御
			continue;
		}
		// 提案の直前に全メンバーのHを読み直して再検証する(Review Focus 5)
		const members = await recheckSet(db, set.members, now);
		if (members === null) {
			continue;
		}
		const outcome = await proposeSet(
			db,
			{
				members,
				score: set.aggregate,
				source: { kind: "group", groupCandidateId },
			},
			now,
			{ notifiedAt: notifiedAt?.() },
		);
		if (outcome === "proposed") {
			proposed = 1;
			break;
		}
		if (outcome === "held") {
			held = 1;
			break;
		}
	}
	return {
		sets: scored.length,
		overThreshold: ranked.length,
		heldSets,
		proposed,
		held,
	};
};
