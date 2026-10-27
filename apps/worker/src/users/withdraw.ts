/**
 * 退会(DELETE /v1/users/me・docs/05 §2.5の「ユーザー退会時」の列・01 §21)。
 * 実行順序はIntent削除(docs/05 §2.5)と同じ考え方で、取り消せない外部の削除を先に行う:
 * (1) 本人の全Intentのベクトル(Vectorize)と(2) R2のアイコンを消す。どちらかが失敗したらD1に
 *     触れずに中断する(利用者は再試行できる。users行はactiveのまま残る)。ベクトルの削除は
 *     Intent削除と同じく0.5秒・1秒の待ちで最大2回やり直す(LAT-126)
 * (3) 本人が参加する進行中の提案(candidate・proposed・partial_accept)をcancelledで閉じる
 *     (システムの都合の取り消しとして提案履歴を消費しない・他のペアの履歴を戻すため(5)より前に行う)
 * (4) 本人が参加を続けるmatchedのLATCHから、参加取り消し(leave)と同じ処理で抜ける
 *     (1対1は双方読み取り専用・グループは本人だけが抜け、下限を割れば全体を取り消す。
 *     2026-10-26オーナー決定・離脱やブロックと区別できない・01 §10)
 * (4b) 本人が参加した閉じた提案の正解データ(calibration_records)を、その時点までの観測で確定して
 *     匿名化する(予測をmatch_candidatesから写すため(5)より前・docs/05 §2.5・LAT-108)
 * (5) D1の削除とusers行のstatus=deletedを1回のbatch(1つの取引)で書く
 * (6) (5)の直前までに作られた進行中の提案を拾い直して閉じ、その分の正解データも匿名化する
 * 残すもの: messages・latch_responses・latch_feedback・blocks・reports・latches・latch_members
 * (表示名は表示の側で「つながっていた相手」に置き換える・docs/05 §2.5)
 */

import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { anonymizeLatches } from "../calibration/records";
import type { Sleep } from "../clock/clock";
import {
	groupCandidates,
	intents,
	latches,
	latchMembers,
	matchCandidates,
	matchEvents,
	notifications,
	proposalHistory,
	pushSubscriptions,
	refreshFamilies,
	sessions,
	surveyResponses,
	usageCounters,
	users,
} from "../db/schema";
import type { Env } from "../env";
import {
	type CancelResult,
	cancelOpenLatchesOnly,
} from "../latches/cancel-open";
import { leave } from "../latches/respond";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";
import { createVectorStore } from "../vectorstore";
import { deleteVectorsWithRetry } from "../vectorstore/delete-retry";

const logger = createLogger();

/** 取り消しの対象になる進行中の状態(cancel-open.tsと同じ) */
const OPEN_STATUSES = ["candidate", "proposed", "partial_accept"] as const;

/** D1の束縛は1文100個まで。idの列挙は50件ずつに分ける(intents.tsのGROUP_DELETE_CHUNKと同じ幅) */
const ID_CHUNK = 50;

const chunksOf = <T>(items: T[], size: number): T[][] => {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
};

/** 中断した段(ログのlayerに出す)。D1は未変更 */
export class WithdrawAbortedError extends Error {
	constructor(
		readonly layer: "vector" | "icon",
		readonly cause: unknown,
	) {
		super(`WITHDRAW_ABORTED: ${layer}の削除に失敗した(docs/05 §2.5)`);
		this.name = "WithdrawAbortedError";
	}
}

export interface WithdrawResult {
	/** 閉じた進行中の提案と、保留を解放する他の参加者(応答の後にreleaseAfterCancelへ渡す) */
	cancelled: CancelResult;
	/** 本人が抜けたmatchedのLATCH(ルートがチャットの接続へclosedを知らせる) */
	leftLatchIds: string[];
}

/** 本人が参加する(離脱していない)LATCHのうち状態がstatusesのもの */
const latchIdsOfMember = async (
	db: DrizzleD1Database,
	userId: string,
	statuses: readonly (typeof latches.$inferSelect)["status"][],
): Promise<string[]> => {
	const rows = await db
		.select({ id: latches.id })
		.from(latchMembers)
		.innerJoin(latches, eq(latches.id, latchMembers.latchId))
		.where(
			and(
				eq(latchMembers.userId, userId),
				isNull(latchMembers.leftAt),
				inArray(latches.status, [...statuses]),
			),
		);
	return rows.map((r) => r.id);
};

/**
 * 正解データの匿名集約。失敗しても退会は止めない(ログだけ出す。参加者が退会したLATCHの行は
 * Cronの正解データの走査が観測の途中でも確定して匿名化する・calibration/records.ts)
 */
const anonymizeCalibration = async (
	db: DrizzleD1Database,
	latchIds: string[],
	now: Date,
): Promise<void> => {
	if (latchIds.length === 0) return;
	try {
		await anonymizeLatches(db, latchIds, now);
	} catch (error) {
		logger.warn("users.withdraw.calibration_failed", {
			error_code: errorCodeOf(error),
		});
	}
};

/** 2回の取り消しの結果を1つにまとめる(保留の解放の宛先は重複を除く) */
const mergeCancel = (a: CancelResult, b: CancelResult): CancelResult => ({
	closedLatchIds: [...a.closedLatchIds, ...b.closedLatchIds],
	releaseUserIds: [...new Set([...a.releaseUserIds, ...b.releaseUserIds])],
});

/**
 * 退会の削除処理を行う。users行がactiveであることの確認と本人確認は呼び出し側(ルート)が行う。
 * 外部の削除に失敗したらWithdrawAbortedErrorを投げる(D1は未変更)。sleepはベクトルの削除の
 * やり直しの待ち(ルートが実時間のsystemSleepを渡す)
 */
export const withdrawUser = async (
	env: Env,
	db: DrizzleD1Database,
	user: typeof users.$inferSelect,
	now: Date,
	sleep: Sleep,
): Promise<WithdrawResult> => {
	const userId = user.id;
	const intentIds = (
		await db
			.select({ id: intents.id })
			.from(intents)
			.where(eq(intents.userId, userId))
	).map((r) => r.id);

	// (1) ベクトルを先に消す(docs/05 §2.5の無条件削除・Intent削除と同じ)。束ごとに短くやり直す
	try {
		const store = createVectorStore(env);
		for (const chunk of chunksOf(intentIds, ID_CHUNK)) {
			await deleteVectorsWithRetry(store, chunk, sleep);
		}
	} catch (error) {
		throw new WithdrawAbortedError("vector", error);
	}
	// (2) R2のアイコン(icon_keyの解除は(5)のbatchで行う)
	if (user.iconKey !== null) {
		try {
			await env.ICONS.delete(user.iconKey);
		} catch (error) {
			throw new WithdrawAbortedError("icon", error);
		}
	}

	// (3) 進行中の提案の取り消し。保留の解放と次の組の提案は応答の後に回す(Intent削除と同じ・#27)
	const firstCancel = await cancelOpenLatchesOnly(
		db,
		await latchIdsOfMember(db, userId, OPEN_STATUSES),
		userId,
		now,
	);

	// (4) 続いているLATCHからの離脱(leaveと同じ処理・2026-10-26オーナー決定)
	const leftLatchIds: string[] = [];
	for (const id of await latchIdsOfMember(db, userId, ["matched"])) {
		const left = await leave(db, id, userId, now);
		if (left.ok) leftLatchIds.push(id);
	}

	// (4b) 正解データの匿名集約。離脱済みのLATCHも含め、本人が参加者だった全LATCHが対象
	const memberLatchIds = (
		await db
			.select({ id: latchMembers.latchId })
			.from(latchMembers)
			.where(eq(latchMembers.userId, userId))
	).map((r) => r.id);
	await anonymizeCalibration(db, memberLatchIds, now);

	// (5) D1の削除。子の行(候補・イベント・通知)を本体(intents)より先に置く(FK)。
	// recent_vectorsはintentsの削除にCASCADEで従う
	const groupCandidateIds: string[] = [];
	for (const id of intentIds) {
		const rows = await db
			.select({ id: groupCandidates.id })
			.from(groupCandidates)
			.where(like(groupCandidates.dedupKey, `%${id}@%`));
		for (const r of rows) groupCandidateIds.push(r.id);
	}
	const intentChunks = chunksOf(intentIds, ID_CHUNK);
	await db.batch([
		db.delete(notifications).where(eq(notifications.userId, userId)),
		...intentChunks.flatMap((chunk) => [
			db
				.delete(matchCandidates)
				.where(
					or(
						inArray(matchCandidates.intentAId, chunk),
						inArray(matchCandidates.intentBId, chunk),
					),
				),
			db.delete(matchEvents).where(inArray(matchEvents.sourceIntentId, chunk)),
			db.delete(usageCounters).where(inArray(usageCounters.key, chunk)),
		]),
		...chunksOf([...new Set(groupCandidateIds)], ID_CHUNK).map((chunk) =>
			db.delete(groupCandidates).where(inArray(groupCandidates.id, chunk)),
		),
		db.delete(intents).where(eq(intents.userId, userId)),
		db
			.delete(proposalHistory)
			.where(
				or(
					eq(proposalHistory.userLow, userId),
					eq(proposalHistory.userHigh, userId),
				),
			),
		db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)),
		db.delete(sessions).where(eq(sessions.userId, userId)),
		db.delete(surveyResponses).where(eq(surveyResponses.userId, userId)),
		db.delete(usageCounters).where(eq(usageCounters.key, userId)),
		db
			.update(refreshFamilies)
			.set({ status: "revoked" })
			.where(eq(refreshFamilies.userId, userId)),
		// 行は残す(再登録で同じ行を使い直す・routes/users.ts)。表示名・ひとこと・アイコンは消す
		db
			.update(users)
			.set({
				status: "deleted",
				displayName: "",
				bio: "",
				iconKey: null,
				updatedAt: now,
			})
			.where(eq(users.id, userId)),
	]);

	// (6) (3)の後・(5)の前に並行した評価が作った提案を閉じる(Intent行は(5)で消えたため以後は作られない)
	const secondCancel = await cancelOpenLatchesOnly(
		db,
		await latchIdsOfMember(db, userId, OPEN_STATUSES),
		userId,
		now,
	);
	// 閉じた提案は本人にもclosedの通知を作るため、本人の通知を消し直す
	if (secondCancel.closedLatchIds.length > 0) {
		await db.delete(notifications).where(eq(notifications.userId, userId));
	}
	// (6)で閉じた提案の正解データ(候補の行は(5)で消えたため予測のJevの軸は残らない)
	await anonymizeCalibration(db, secondCancel.closedLatchIds, now);
	return { cancelled: mergeCancel(firstCancel, secondCancel), leftLatchIds };
};
