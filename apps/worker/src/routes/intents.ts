/**
 * Intent APIルート(docs/05 §3.2)。
 * - POST /v1/intents/parse: raw_textをParser(docs/07 §2)で構造化して応答する。保存しない。
 *   geoは解決しないため常にnull・participants.includes_ownerはtrue・budgetの通貨はJPY固定
 * - POST /v1/intents: draft=意味検証なしで保存(version=1・expires_at=null可) /
 *   active=validateIntentForActive(違反は400・details.reasons)→参加中active数が上限
 *   (LIMITS.ACTIVE_INTENTS_PER_USER)以上なら422 ACTIVE_INTENT_LIMIT→期限を確定して保存。
 *   visibilityは"hidden_until_match"固定でリクエストでは受けない(docs/01 §21)。
 *   draftでは期限の選択(expires_in_days)を受けない(選択は預ける時に確定・docs/05 §3.2)
 * - GET /v1/intents: 自Intent一覧。自ユーザーのみ・id降順(ULID=新着順)・
 *   limit=1..50既定20・cursorは不透明(base64url化した最終id)・statusは単一値の絞り込み
 * - GET /v1/intents/{id}: 取得。他人の・存在しないは一律404(存在を隠す・docs/05 §3.1)
 * - PATCH /v1/intents/{id}: 部分更新(version+1・docs/01 §16)。draft=全項目可変+
 *   status:"active"でactive化(マージ結果をvalidateIntentForActive→ACTIVE_INTENT_LIMIT→
 *   期限確定)。active=可変はtopic・time・geo・participants・budget・constraints・
 *   notification_levelのみ(他フィールドは400 field_not_allowed)。
 *   paused/matched/expired/cancelled行は400 invalid_status
 * - DELETE /v1/intents/{id}: 削除(所有者のみ・他人は404)。後始末(docs/05 §2.5)として
 *   まずVectorizeのベクトルを即時削除(失敗時は500で削除全体を中断・D1未削除)し、
 *   次に1対1候補・グループ候補・イベント投入記録の子行を削除してから本体を削除する
 * - POST /v1/intents/{id}/pause: 一時停止。activeのみ可(他は400 invalid_status)。
 *   status=paused・version+1。期限は変更しない。Vectorize metadataのstatusを
 *   pausedへ即時同期(ベストエフォート・docs/06 §2)
 * - POST /v1/intents/{id}/resume: 再開。pausedのみ可(他は400 invalid_status)。
 *   期限切れ(expires_at<=now)は400(expired遷移自体はF3のCron)。active化と同じ
 *   ACTIVE_INTENT_LIMIT検証(422)。status=active・version+1・期限は据え置き。
 *   Vectorize metadataのstatusをactiveへ戻し、intent_updatedを即時発行(docs/06 §2)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点(composition root)のためsystemClockをimportして使う
 */

import {
	createIntentRequestSchema,
	type IntentDTO,
	type IntentForm,
	type IntentStatus,
	intentStatusSchema,
	LIMITS,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
	type ParseIntentResponse,
	PIPELINE,
	parseIntentRequestSchema,
	parseResponseSchema,
	patchIntentRequestSchema,
} from "@latch/shared";
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import {
	groupCandidates,
	intents,
	matchCandidates,
	matchEvents,
	notifications,
	users,
} from "../db/schema";
import type { Env } from "../env";
import { type ErrorResult, errorJson } from "../http/errors";
import { newUlid } from "../ids";
import { MS_PER_DAY } from "../intents/expiry";
import {
	isAlcoholRestricted,
	validateIntentForActive,
} from "../intents/validation";
import {
	cancelOpenLatches,
	openLatchIdsOfIntent,
	proposeNextGroupsAfterCancel,
} from "../latches/cancel-open";
import { createLlm } from "../llm/mode";
import { createLogger } from "../logging/logger";
import { errorCodeOf } from "../pipeline/errors";
import { emitMatchEvent } from "../pipeline/events";
import { pushFlushAfterWrite } from "../push/flush-middleware";
import { createVectorStore } from "../vectorstore";
import { syncVectorStatus } from "../vectorstore/sync-status";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。raw_text・topic・座標は決して出力しない */
const logger = createLogger();

/** Intent APIのサブアプリ。index.tsが /v1/intents にマウントする(docs/05 §3.2) */
export const intentRoutes = new Hono<AppEnv>();

// 変更系の成功後にWeb Pushを送り出す(F7b設計 §5.1)
intentRoutes.use("*", pushFlushAfterWrite);

/** D1接続。envのバインディングからdrizzleインスタンスを作る(軽量オブジェクトのため関数ごとの生成でよい) */
const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** JSONボディを読む。空ボディは{}・JSON不正はundefined(400扱い)(users.tsと同一のhelper) */
const readJsonBody = async (c: Context<AppEnv>): Promise<unknown> => {
	try {
		const text = await c.req.text();
		return text === "" ? {} : JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** 400 VALIDATION_FAILED(リクエスト検証の失敗・docs/05 §3.1) */
const validationFailed = () =>
	errorJson("VALIDATION_FAILED", "リクエストボディが不正です");

/**
 * sub未保証時の防御応答。requireRegisteredが保証するため到達しない(docs/05 §3.1)。
 * POST以外の各ルートでも同一の形で使う
 */
const unauthorizedForRegistered = () =>
	errorJson(
		"UNAUTHORIZED",
		"この操作には登録済みユーザーのアクセストークンが必要です",
	);

/**
 * 20歳未満の飲酒を含む機会Intentの有効化を拒む(F7a設計 §4・docs/08 §8)。
 * 拒否ならErrorResult・通すならnullを返す。上限判定より先に呼ぶ。
 * 飲酒を含む機会Intentで本人のusers行が無い・statusがactiveでないときは、
 * 年齢を確かめられないので拒否する(安全側・飲酒を含まないIntentの挙動は変えない)
 */
const rejectIfAlcoholRestricted = async (
	db: DrizzleD1Database,
	userId: string,
	f: { form: IntentForm | null; alcoholInvolved: boolean },
	now: Date,
	event: "intents.create.rejected" | "intents.update.rejected",
): Promise<ErrorResult | null> => {
	if (f.form !== "occasion" || !f.alcoholInvolved) {
		return null;
	}
	const [owner] = await db
		.select({ birthDate: users.birthDate, status: users.status })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const unverifiable = owner === undefined || owner.status !== "active";
	if (unverifiable || isAlcoholRestricted(f, owner.birthDate, now)) {
		logger.warn(event, { error_code: "ALCOHOL_RESTRICTED" });
		return errorJson(
			"ALCOHOL_RESTRICTED",
			"20歳未満の方、または年齢を確認できない場合は、お酒を含む機会のIntentを有効にできません",
		);
	}
	return null;
};

/** 404 NOT_FOUND。他人の・存在しないIntentは区別せず存在を隠す(docs/05 §3.1) */
const notFound = () => errorJson("NOT_FOUND", "Intentが見つかりません");

/**
 * 楽観ロック付きUPDATEの結果。ok時は更新後の行・失敗時は原因
 * (version_conflict=並行更新でversionが進んだ・not_found=並行削除で消えた)
 */
export type GuardedUpdate =
	| { kind: "ok"; row: typeof intents.$inferSelect }
	| { kind: "version_conflict" }
	| { kind: "not_found" };

/**
 * version楽観ロック付きUPDATE(PATCH・pause・resume共通・docs/01 §16・05 §3.3)。
 * 読み出し時のversion(row.version)と一致する行のみ更新するため、並行更新が
 * 両方成功して後勝ち上書きになることはない。更新が0行だった場合は1回だけ再読込して
 * 原因を確定し、行が残っていればversion_conflict・消えていればnot_foundを返す。
 * valuesにはversion(row.version+1)とupdatedAtを含めた更新内容を呼び出し側で組みて渡す
 */
export const updateWithOptimisticLock = async (
	db: DrizzleD1Database,
	row: typeof intents.$inferSelect,
	userId: string,
	values: Partial<typeof intents.$inferInsert>,
): Promise<GuardedUpdate> => {
	const [updated] = await db
		.update(intents)
		.set(values)
		.where(
			and(
				eq(intents.id, row.id),
				eq(intents.userId, userId),
				// 読み出し時のversionとの一致を更新条件に含める(楽観ロック・docs/01 §16)
				eq(intents.version, row.version),
			),
		)
		.returning();
	if (updated !== undefined) {
		return { kind: "ok", row: updated };
	}
	// 0行: 1回だけ再読込して原因を確定する(行消滅→not_found・残存→version衝突)
	const [current] = await db
		.select()
		.from(intents)
		.where(and(eq(intents.id, row.id), eq(intents.userId, userId)));
	if (current === undefined) {
		return { kind: "not_found" };
	}
	return { kind: "version_conflict" };
};

/** 楽観ロック失敗時のエラー応答。version衝突は400(version_conflict)・行消滅は一律404 */
const guardedUpdateFailure = (
	kind: "version_conflict" | "not_found",
): ErrorResult =>
	kind === "version_conflict"
		? errorJson(
				"VALIDATION_FAILED",
				"他の操作と競合しました。最新の状態を読み込み直してやり直してください",
				{ reasons: ["version_conflict"] },
			)
		: notFound();

/** 一覧cursorの不透明化(docs/05 §3.1): ページの最終idをbase64url化する */
const encodeCursor = (id: string): string =>
	btoa(id).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/**
 * cursor→最終id。base64urlとして復号できない・復号結果がULID(26文字・
 * Crockford Base32)の形でない場合はnull(呼び出し側が400にする)
 */
const decodeCursor = (cursor: string): string | null => {
	let base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
	while (base64.length % 4 !== 0) {
		base64 += "=";
	}
	let decoded: string;
	try {
		decoded = atob(base64);
	} catch {
		return null;
	}
	return /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(decoded) ? decoded : null;
};

/** intents行→IntentDTO(docs/05 §3.3)。ISO化はtoISOString()。一覧・更新系のルートでも使う */
export const toIntentDto = (row: typeof intents.$inferSelect): IntentDTO => ({
	id: row.id,
	form: row.form,
	topic: row.topic,
	category: row.category,
	raw_text: row.rawText,
	time:
		row.startsAt === null
			? null
			: {
					start: row.startsAt.toISOString(),
					end: row.endsAt === null ? null : row.endsAt.toISOString(),
				},
	// 3つ(lat/lng/radius)揃うか全てnullで保存するため、欠けはnullへ倒す(docs/05 §2.2)
	geo:
		row.geoCenterLat === null ||
		row.geoCenterLng === null ||
		row.geoRadiusM === null
			? null
			: {
					center: { lat: row.geoCenterLat, lng: row.geoCenterLng },
					radius_m: row.geoRadiusM,
				},
	participants: {
		min: row.participantsMin,
		max: row.participantsMax,
		includes_owner: row.participantsIncludesOwner,
	},
	budget:
		row.budgetMin === null || row.budgetMax === null || row.currency === null
			? null
			: {
					min: row.budgetMin,
					max: row.budgetMax,
					// 通貨列は書き込み時に"JPY"のみ格納する(docs/05 §2.2: budget通貨はJPY固定)
					currency: row.currency as "JPY",
				},
	// constraintsのjson列はDrizzle写像規約で$type未指定(検証はZod層=packages/shared)のため
	// 読み出しがunknown。書き込みはconstraintsSchemaの文字列配列に限るため画一的に受ける
	hard_constraints: row.hardConstraints as string[],
	soft_constraints: row.softConstraints as string[],
	negative_constraints: row.negativeConstraints as string[],
	visibility: row.visibility,
	notification_level: row.notificationLevel,
	alcohol_involved: row.alcoholInvolved,
	status: row.status,
	version: row.version,
	expires_at: row.expiresAt === null ? null : row.expiresAt.toISOString(),
	created_at: row.createdAt.toISOString(),
	updated_at: row.updatedAt.toISOString(),
});

/**
 * active更新での意味フィールド変更判定(docs/06 §2のintent_updated発行条件)。
 * 更新前の行(row)と更新後の行(updated)を比較し、topic・time(starts_at/ends_atの
 * エポックms)・geo(lat/lng/radiusの3値)・participants(min/max/includes_owner)・
 * budget(min/max)・constraints 3種(JSON文字列比較)のいずれかが変わったときtrue。
 * participantsはdocs/05 §3.2の可変フィールドどおりincludes_owner込み
 * (正規化テキストの「募集2〜4人」表記に反映されるため)。notification_level・
 * currency等の表示・補助設定の変更は再評価の起点にしないため発行条件に含めない
 */
const intentMeaningChanged = (
	row: typeof intents.$inferSelect,
	updated: typeof intents.$inferSelect,
): boolean =>
	updated.topic !== row.topic ||
	(updated.startsAt?.getTime() ?? null) !== (row.startsAt?.getTime() ?? null) ||
	(updated.endsAt?.getTime() ?? null) !== (row.endsAt?.getTime() ?? null) ||
	updated.geoCenterLat !== row.geoCenterLat ||
	updated.geoCenterLng !== row.geoCenterLng ||
	updated.geoRadiusM !== row.geoRadiusM ||
	updated.participantsMin !== row.participantsMin ||
	updated.participantsMax !== row.participantsMax ||
	updated.participantsIncludesOwner !== row.participantsIncludesOwner ||
	updated.budgetMin !== row.budgetMin ||
	updated.budgetMax !== row.budgetMax ||
	JSON.stringify(updated.hardConstraints) !==
		JSON.stringify(row.hardConstraints) ||
	JSON.stringify(updated.softConstraints) !==
		JSON.stringify(row.softConstraints) ||
	JSON.stringify(updated.negativeConstraints) !==
		JSON.stringify(row.negativeConstraints);

// metadata.statusの同期(syncVectorStatus)はvectorstore/sync-status.tsの共通ヘルパーを使う
// (pause/resumeとCronの期限切れ2窓走査の共用・docs/06 §2)

intentRoutes.post("/parse", requireRegistered, async (c) => {
	const parsed = parseIntentRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	// Parserはstub(決定的・docs/07 §2)。real適用は精度ゲート(07 §6)合格後。
	// createLlmの引数型はwrangler生成の完全なEnv(worker-configuration.d.tsのambient型)。
	// c.env(AppEnv.Bindings・src/env.tsのEnv)は同一実行時値の宣言部分型のため画一的に受ける
	const result = createLlm(
		c.env as unknown as Parameters<typeof createLlm>[0],
		systemClock,
	).parser(parsed.data.raw_text);
	const body: ParseIntentResponse = {
		form: result.form,
		topic: result.topic,
		category: result.category,
		time: result.time,
		// parseは地域を解決しない(ユーザーが添付で確定させる・docs/05 §3.3)
		geo: null,
		// オーナー含む既定
		participants: { ...result.participants, includes_owner: true },
		budget:
			result.budget === null ? null : { ...result.budget, currency: "JPY" },
		expires_at_options: result.expires_at_options,
		alcohol_involved: result.alcohol_involved,
		warnings: result.warnings,
	};
	// 応答契約の保証(docs/05 §3.3): 組立後に応答スキーマで再検証し、契約外の値
	// (Parser実装の逸脱)は200で返さずPARSE_FAILED(422)に倒す。通常のstubでは通らない防御
	const checked = parseResponseSchema.safeParse(body);
	if (!checked.success) {
		logger.warn("intents.parse.failed", { error_code: "PARSE_FAILED" });
		const r = errorJson(
			"PARSE_FAILED",
			"解析に失敗しました。入力を見直してください",
		);
		return c.json(r.body, r.status);
	}
	logger.info("intents.parse.previewed");
	return c.json(body, 200);
});

intentRoutes.post("/", requireRegistered, async (c) => {
	const parsed = createIntentRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		logger.warn("intents.create.rejected", { error_code: "VALIDATION_FAILED" });
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const d = parsed.data;

	// draft保存では期限の選択(expires_in_days)を受けない・選択は預ける時(active化)に
	// 確定する(docs/05 §3.2)。status:"active"を伴うリクエストでは有効
	if (d.status === "draft" && d.expires_in_days !== undefined) {
		logger.warn("intents.create.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"draft保存では期限日数を選択できません。有効化する際に選択してください",
			{ reasons: ["expires_choice_on_draft"] },
		);
		return c.json(r.body, r.status);
	}
	// 機会Intentのactive作成に期限日数の選択は不可(期限は開始時刻基準で確定するため・
	// docs/05 §3.3)。黙って無視せず400で返す
	if (
		d.status === "active" &&
		d.form === "occasion" &&
		d.expires_in_days !== undefined
	) {
		logger.warn("intents.create.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"機会Intentには期限日数を選択できません。開始時刻に基づく期限が適用されます",
			{ reasons: ["expires_in_days_not_allowed"] },
		);
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const now = systemClock.now();

	// 時刻入力はDateへ変換して保存する(UTC・docs/05 §2.2)。ISO文字列からのnew Dateは可
	const startsAt = d.time ? new Date(d.time.start) : null;
	const endsAt = d.time?.end ? new Date(d.time.end) : null;
	const explicitExpiresAt = d.expires_at ? new Date(d.expires_at) : null;

	// draft保存ではnull可・activeは検証結果の期限で上書きする(docs/05 §2.2)
	let expiresAt: Date | null = explicitExpiresAt;
	if (d.status === "active") {
		// active化の意味検証(意味検証はdraftでは行わない・docs/05 §3.2)
		const validation = validateIntentForActive(
			{
				form: d.form ?? null,
				topic: d.topic ?? null,
				startsAt,
				alcoholInvolved: d.alcohol_involved,
				explicitExpiresAt,
				expiresInDays: d.expires_in_days,
			},
			now,
		);
		if (!validation.ok) {
			logger.warn("intents.create.rejected", {
				error_code: "VALIDATION_FAILED",
			});
			const r = errorJson(
				"VALIDATION_FAILED",
				"Intentを有効にするには内容の確認が必要です",
				{ reasons: validation.reasons },
			);
			return c.json(r.body, r.status);
		}
		const alcoholRejection = await rejectIfAlcoholRestricted(
			db,
			sub,
			{ form: d.form ?? null, alcoholInvolved: d.alcohol_involved },
			now,
			"intents.create.rejected",
		);
		if (alcoholRejection) {
			return c.json(alcoholRejection.body, alcoholRejection.status);
		}
		// 参加中active数の上限(上限5件・docs/05 §3.1のACTIVE_INTENT_LIMIT=422)
		const [counted] = await db
			.select({ value: count() })
			.from(intents)
			.where(and(eq(intents.userId, sub), eq(intents.status, "active")));
		if ((counted?.value ?? 0) >= LIMITS.ACTIVE_INTENTS_PER_USER) {
			logger.warn("intents.create.rejected", {
				error_code: "ACTIVE_INTENT_LIMIT",
			});
			const r = errorJson(
				"ACTIVE_INTENT_LIMIT",
				"参加中のIntentが上限に達しています。既存のIntentを見直してください",
			);
			return c.json(r.body, r.status);
		}
		// 期限は検証結果(active化時刻+7/30/90日・start+3時間・明示値)で確定
		expiresAt = validation.expiresAt;
	}

	const [inserted] = await db
		.insert(intents)
		.values({
			id: newUlid(),
			userId: sub,
			// draft保存では意味検証せずnull許容(active化時に検証・docs/05 §2.2)
			form: d.form ?? null,
			topic: d.topic ?? null,
			category: d.category ?? null,
			rawText: d.raw_text,
			startsAt,
			endsAt,
			geoCenterLat: d.geo?.center.lat ?? null,
			geoCenterLng: d.geo?.center.lng ?? null,
			geoRadiusM: d.geo?.radius_m ?? null,
			participantsMin: d.participants.min,
			participantsMax: d.participants.max,
			participantsIncludesOwner: d.participants.includes_owner,
			budgetMin: d.budget?.min ?? null,
			budgetMax: d.budget?.max ?? null,
			currency: d.budget?.currency ?? null,
			hardConstraints: d.hard_constraints,
			softConstraints: d.soft_constraints,
			negativeConstraints: d.negative_constraints,
			// v1.0はhidden_until_match単値(リクエストでは受けない・docs/01 §21)
			visibility: "hidden_until_match",
			notificationLevel: d.notification_level,
			alcoholInvolved: d.alcohol_involved,
			status: d.status,
			// 初回作成はversion=1(docs/01 §16)
			version: 1,
			expiresAt,
			// 埋め込みはF3(Embeddingイベント発行時)まで未実施
			embeddingModel: null,
			embeddedAt: null,
			lastEvaluatedAt: null,
			vectorDeletedAt: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (inserted === undefined) {
		const r = errorJson("INTERNAL", "Intentの作成に失敗しました");
		return c.json(r.body, r.status);
	}
	logger.info("intents.created", {
		intent_id: inserted.id,
		status: inserted.status,
		version: inserted.version,
	});
	// イベント発行(docs/06 §2): active作成はintent_createdを即時投入する。
	// draft保存では発行しない。waitUntilでsendし、応答をブロックしない(04 §7の保存p95)
	if (inserted.status === "active") {
		c.executionCtx.waitUntil(
			emitMatchEvent(
				c.env,
				{
					eventType: "intent_created",
					intentId: inserted.id,
					version: inserted.version,
				},
				undefined,
				systemClock,
			),
		);
	}
	return c.json(toIntentDto(inserted), 201);
});

/**
 * GET /v1/intents(自Intent一覧・docs/05 §3.1・§3.2)。自ユーザーのみ・id降順
 * (ULID=新着順)。limit=1..50既定20・cursorは不透明(base64url化した最終id)・
 * statusは単一値のoptional絞り込み。応答は{items, next_cursor}
 */
intentRoutes.get("/", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}

	// status絞り込み(単一値・docs/05 §3.2)。不明な値は400
	let statusFilter: IntentStatus | undefined;
	const statusParam = c.req.query("status");
	if (statusParam !== undefined) {
		const parsedStatus = intentStatusSchema.safeParse(statusParam);
		if (!parsedStatus.success) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		statusFilter = parsedStatus.data;
	}

	// limit=1..50既定20(docs/05 §3.1)。Number()は「1e1」「0x10」「 5 」等も数値化して
	// しまうため、先に「数字のみの1〜2桁」の事前照合を行い、範囲外は400にする
	let limit = 20;
	const limitParam = c.req.query("limit");
	if (limitParam !== undefined) {
		if (!/^[0-9]{1,2}$/u.test(limitParam)) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		const parsedLimit = Number(limitParam);
		if (parsedLimit < 1 || parsedLimit > 50) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		limit = parsedLimit;
	}

	// cursorは不透明(base64url化した最終id)。復号できない値は400(docs/05 §3.1)
	let cursorId: string | undefined;
	const cursorParam = c.req.query("cursor");
	if (cursorParam !== undefined) {
		const decoded = decodeCursor(cursorParam);
		if (decoded === null) {
			const r = validationFailed();
			return c.json(r.body, r.status);
		}
		cursorId = decoded;
	}

	const conditions = [eq(intents.userId, sub)];
	if (statusFilter !== undefined) {
		conditions.push(eq(intents.status, statusFilter));
	}
	if (cursorId !== undefined) {
		// id降順の続きから=cursor(前ページの最終id)より小さいid
		conditions.push(lt(intents.id, cursorId));
	}

	// 終端判定(next_cursor)のためにlimit+1件取得する
	const rows = await dbOf(c.env)
		.select()
		.from(intents)
		.where(and(...conditions))
		.orderBy(desc(intents.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const items = (hasMore ? rows.slice(0, limit) : rows).map(toIntentDto);
	const lastItem = items[items.length - 1];
	const body: { items: IntentDTO[]; next_cursor: string | null } = {
		items,
		// 続きがあるときだけ「このページの最終id」を不透明化して返す
		next_cursor:
			hasMore && lastItem !== undefined ? encodeCursor(lastItem.id) : null,
	};
	return c.json(body, 200);
});

/** GET /v1/intents/{id}(取得・docs/05 §3.2)。他人の・存在しないは一律404(docs/05 §3.1) */
intentRoutes.get("/:id", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const [row] = await dbOf(c.env)
		.select()
		.from(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)));
	if (row === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	return c.json(toIntentDto(row), 200);
});

/**
 * PATCH /v1/intents/{id}(部分更新・version+1・docs/05 §3.2・§2.2・01 §16)。
 * draft=全項目可変+status:"active"でactive化(マージ結果をvalidateIntentForActive→
 * ACTIVE_INTENT_LIMIT→期限確定)。draftままでの期限日数選択は不可・明示expires_atの
 * 格納は可。active=可変はtopic・time・geo・participants・budget・constraints・
 * notification_levelのみ。機会のstarts_at変更時は現在以降〜now+7日以内+現在の
 * expires_atより前を再検証。paused/matched/expired/cancelled行は更新不可。
 * 他人の・存在しないは一律404(存在を隠す・docs/05 §3.1)
 */
intentRoutes.patch("/:id", requireRegistered, async (c) => {
	const parsed = patchIntentRequestSchema.safeParse(await readJsonBody(c));
	if (!parsed.success) {
		logger.warn("intents.update.rejected", { error_code: "VALIDATION_FAILED" });
		const r = validationFailed();
		return c.json(r.body, r.status);
	}
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const d = parsed.data;
	const db = dbOf(c.env);
	const [row] = await db
		.select()
		.from(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)));
	if (row === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	const now = systemClock.now();

	// draft/active以外の行は更新できない(docs/05 §3.2)
	if (row.status !== "draft" && row.status !== "active") {
		logger.warn("intents.update.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"この状態のIntentは更新できません",
			{
				reasons: ["invalid_status"],
			},
		);
		return c.json(r.body, r.status);
	}

	// activeは可変フィールドが限定される(docs/05 §3.2)。form・category・raw_text・
	// status・alcohol_involved・expires_*の指定は不可
	if (row.status === "active") {
		const forbidden =
			d.form !== undefined ||
			d.category !== undefined ||
			d.raw_text !== undefined ||
			d.status !== undefined ||
			d.alcohol_involved !== undefined ||
			d.expires_in_days !== undefined ||
			d.expires_at !== undefined;
		if (forbidden) {
			logger.warn("intents.update.rejected", {
				error_code: "VALIDATION_FAILED",
			});
			const r = errorJson(
				"VALIDATION_FAILED",
				"有効なIntentではこのフィールドは変更できません",
				{ reasons: ["field_not_allowed"] },
			);
			return c.json(r.body, r.status);
		}
	}

	// draftままでの期限日数選択は不可・選択は預ける時(active化)に確定(docs/05 §3.2)
	if (
		row.status === "draft" &&
		d.expires_in_days !== undefined &&
		d.status !== "active"
	) {
		logger.warn("intents.update.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"draftでは期限日数を選択できません。有効化する際に選択してください",
			{ reasons: ["expires_choice_on_draft"] },
		);
		return c.json(r.body, r.status);
	}

	// マージは「行の現行値+patchの指定値」の純粋な上書き。日時はISO→Dateで保存・比較
	const mergedStartsAt =
		d.time === undefined
			? row.startsAt
			: d.time === null
				? null
				: new Date(d.time.start);
	const mergedEndsAt =
		d.time === undefined
			? row.endsAt
			: d.time === null
				? null
				: d.time.end === null
					? null
					: new Date(d.time.end);

	// activeのつながりにtimeを指定する変更は不可・つながりIntentはstarts_at=null不変
	// (docs/05 §2.2)。time:nullの明示は可で、nullを指定したフィールドはそのままnullに
	// なる(「現行値の維持」ではなく値の明示的設定)。機会Intentのtime:nullは
	// 下の再検証でstarts_at_required=400になる
	if (
		row.status === "active" &&
		row.form === "connection" &&
		d.time !== undefined &&
		d.time !== null
	) {
		logger.warn("intents.update.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"つながりIntentには開始時刻を設定できません",
			{ reasons: ["starts_at_not_allowed"] },
		);
		return c.json(r.body, r.status);
	}

	// activeの機会でstarts_atを変更する場合は範囲と期限を再検証する(docs/05 §3.2)
	if (
		row.status === "active" &&
		row.form === "occasion" &&
		d.time !== undefined
	) {
		const reasons: string[] = [];
		if (mergedStartsAt === null) {
			// activeの機会はstarts_at必須(docs/05 §2.2)
			reasons.push("starts_at_required");
		} else {
			const t = mergedStartsAt.getTime();
			if (
				t < now.getTime() ||
				t > now.getTime() + OCCASION_STARTS_AT_MAX_DAYS_AHEAD * MS_PER_DAY
			) {
				reasons.push("starts_at_out_of_range");
			}
			if (row.expiresAt !== null && t >= row.expiresAt.getTime()) {
				reasons.push("starts_at_after_expires");
			}
		}
		if (reasons.length > 0) {
			logger.warn("intents.update.rejected", {
				error_code: "VALIDATION_FAILED",
			});
			const r = errorJson(
				"VALIDATION_FAILED",
				"開始時刻は現在以降で現在の期限より前に収める必要があります",
				{ reasons },
			);
			return c.json(r.body, r.status);
		}
	}

	// active化(draft行のみ到達する: active行のstatus指定は上でfield_not_allowed)
	let nextStatus: IntentStatus = row.status;
	let expiresAt: Date | null;
	if (d.status === "active") {
		// 機会Intentのactive化に期限日数の選択は不可(期限は開始時刻基準で確定するため・
		// docs/05 §3.3)。黙って無視せず400で返す
		if (
			(d.form ?? row.form) === "occasion" &&
			d.expires_in_days !== undefined
		) {
			logger.warn("intents.update.rejected", {
				error_code: "VALIDATION_FAILED",
			});
			const r = errorJson(
				"VALIDATION_FAILED",
				"機会Intentには期限日数を選択できません。開始時刻に基づく期限が適用されます",
				{ reasons: ["expires_in_days_not_allowed"] },
			);
			return c.json(r.body, r.status);
		}
		const explicitExpiresAt =
			d.expires_at === undefined ? null : new Date(d.expires_at);
		// マージ結果の検証(意味検証はdraftでは行わずactive化時に行う・docs/05 §3.2)
		const validation = validateIntentForActive(
			{
				form: d.form ?? row.form,
				topic: d.topic ?? row.topic,
				startsAt: mergedStartsAt,
				alcoholInvolved: d.alcohol_involved ?? row.alcoholInvolved,
				// draft保存時に確定していた期限(patchでexpires_at指定時はその値)
				storedExpiresAt:
					d.expires_at === undefined ? row.expiresAt : explicitExpiresAt,
				explicitExpiresAt,
				expiresInDays: d.expires_in_days,
			},
			now,
		);
		if (!validation.ok) {
			logger.warn("intents.update.rejected", {
				error_code: "VALIDATION_FAILED",
			});
			const r = errorJson(
				"VALIDATION_FAILED",
				"Intentを有効にするには内容の確認が必要です",
				{ reasons: validation.reasons },
			);
			return c.json(r.body, r.status);
		}
		const alcoholRejection = await rejectIfAlcoholRestricted(
			db,
			sub,
			{
				form: d.form ?? row.form,
				alcoholInvolved: d.alcohol_involved ?? row.alcoholInvolved,
			},
			now,
			"intents.update.rejected",
		);
		if (alcoholRejection) {
			return c.json(alcoholRejection.body, alcoholRejection.status);
		}
		// 参加中active数の上限(上限5件・docs/05 §3.1のACTIVE_INTENT_LIMIT=422)
		const [counted] = await db
			.select({ value: count() })
			.from(intents)
			.where(and(eq(intents.userId, sub), eq(intents.status, "active")));
		if ((counted?.value ?? 0) >= LIMITS.ACTIVE_INTENTS_PER_USER) {
			logger.warn("intents.update.rejected", {
				error_code: "ACTIVE_INTENT_LIMIT",
			});
			const r = errorJson(
				"ACTIVE_INTENT_LIMIT",
				"参加中のIntentが上限に達しています。既存のIntentを見直してください",
			);
			return c.json(r.body, r.status);
		}
		nextStatus = "active";
		// 期限は検証結果(明示expires_at・保存値・active化時刻+7/30/90日・start+3時間)で確定
		expiresAt = validation.expiresAt;
	} else {
		// draftのまま: 期限は保存値のままか明示expires_atの指定で置き換わる
		expiresAt =
			d.expires_at === undefined ? row.expiresAt : new Date(d.expires_at);
	}

	const result = await updateWithOptimisticLock(db, row, sub, {
		form: d.form ?? row.form,
		topic: d.topic ?? row.topic,
		category: d.category === undefined ? row.category : d.category,
		rawText: d.raw_text ?? row.rawText,
		startsAt: mergedStartsAt,
		endsAt: mergedEndsAt,
		geoCenterLat:
			d.geo === undefined ? row.geoCenterLat : (d.geo?.center.lat ?? null),
		geoCenterLng:
			d.geo === undefined ? row.geoCenterLng : (d.geo?.center.lng ?? null),
		geoRadiusM:
			d.geo === undefined ? row.geoRadiusM : (d.geo?.radius_m ?? null),
		participantsMin: d.participants?.min ?? row.participantsMin,
		participantsMax: d.participants?.max ?? row.participantsMax,
		participantsIncludesOwner:
			d.participants?.includes_owner ?? row.participantsIncludesOwner,
		budgetMin: d.budget === undefined ? row.budgetMin : (d.budget?.min ?? null),
		budgetMax: d.budget === undefined ? row.budgetMax : (d.budget?.max ?? null),
		currency:
			d.budget === undefined ? row.currency : (d.budget?.currency ?? null),
		hardConstraints: d.hard_constraints ?? row.hardConstraints,
		softConstraints: d.soft_constraints ?? row.softConstraints,
		negativeConstraints: d.negative_constraints ?? row.negativeConstraints,
		notificationLevel: d.notification_level ?? row.notificationLevel,
		alcoholInvolved: d.alcohol_involved ?? row.alcoholInvolved,
		status: nextStatus,
		// 更新ごとにversion+1(docs/01 §16)
		version: row.version + 1,
		expiresAt,
		updatedAt: now,
	});
	if (result.kind !== "ok") {
		if (result.kind === "version_conflict") {
			logger.warn("intents.update.conflict", {
				error_code: "VALIDATION_FAILED",
			});
		}
		const r = guardedUpdateFailure(result.kind);
		return c.json(r.body, r.status);
	}
	logger.info("intents.updated", {
		intent_id: result.row.id,
		status: result.row.status,
		version: result.row.version,
	});
	// active更新で意味フィールドが変わった・期限が短くなった場合は、このIntentを含む進行中の
	// 提案を取り消す(docs/01 §8「Hard Constraintが変化した」・docs/05 §3.2)。再評価は下の
	// intent_updatedで走り、新しい内容で再提案され得る。表示系だけの変更では閉じない
	if (
		row.status === "active" &&
		result.row.status === "active" &&
		(intentMeaningChanged(row, result.row) ||
			(row.expiresAt !== null &&
				result.row.expiresAt !== null &&
				result.row.expiresAt.getTime() < row.expiresAt.getTime()))
	) {
		// 版は更新済みのため、旧版を含む評価済みの集合は次集合の版照合で除かれる
		const closedLatchIds = await cancelOpenLatches(
			db,
			await openLatchIdsOfIntent(db, result.row.id),
			sub,
			now,
		);
		await proposeNextGroupsAfterCancel(db, closedLatchIds, now);
	}
	// 意味フィールドの更新では30分の再評価抑制を解除する(オーナー裁定 2026-10-20・docs/06 §3)。
	// 抑制は同じ内容の繰り返し評価を防ぐためのもので、内容が変われば理由がなくなる。費用は
	// 更新6回/時(docs/04 §5)とJev予算で別に抑えられている。並行更新で版が進んでいれば触らない
	if (row.status === "active" && intentMeaningChanged(row, result.row)) {
		await db
			.update(intents)
			.set({ lastEvaluatedAt: null })
			.where(
				and(
					eq(intents.id, result.row.id),
					eq(intents.version, result.row.version),
				),
			);
	}
	// イベント発行(docs/06 §2): draft→active化はintent_createdを即時投入。activeは
	// 意味フィールド(topic・time・geo・participants・budget・constraints)が変わったとき
	// だけintent_updatedを10秒遅延で投入する(notification_levelのみの変更と
	// draftままでの編集は発行しない)。waitUntilでsendし、応答をブロックしない
	if (row.status === "draft" && result.row.status === "active") {
		c.executionCtx.waitUntil(
			emitMatchEvent(
				c.env,
				{
					eventType: "intent_created",
					intentId: result.row.id,
					version: result.row.version,
				},
				undefined,
				systemClock,
			),
		);
	} else if (row.status === "active" && intentMeaningChanged(row, result.row)) {
		c.executionCtx.waitUntil(
			emitMatchEvent(
				c.env,
				{
					eventType: "intent_updated",
					intentId: result.row.id,
					version: result.row.version,
				},
				{ delaySeconds: PIPELINE.UPDATE_EVENT_DELAY_SECONDS },
				systemClock,
			),
		);
	}
	return c.json(toIntentDto(result.row), 200);
});

/** 削除APIの段ごとの所要時間(vector/d1_children/d1_intent・遅い段の切り分け用) */
const logDeleteTiming = (
	intentId: string,
	layer: "vector" | "d1_children" | "d1_intent",
	startedAt: number,
): void => {
	logger.info("intents.delete.timing", {
		intent_id: intentId,
		layer,
		latency: systemClock.now().getTime() - startedAt,
	});
};

/**
 * DELETE /v1/intents/{id}(削除・docs/05 §3.2)。所有者のみ・他人は404(存在を隠す)。
 * 削除の後始末(docs/05 §2.5の無条件削除): まずVectorizeのベクトルを即時削除する
 * (期限+7日の遅延ではない)。ここが失敗した場合は削除全体を中断して500 INTERNAL
 * (D1は未削除のため再試行可能)。この順序により「Intent行が消えたならベクトルも
 * 消えている」が保証され、検索可能な孤立埋め込みが残らない。逆にベクトル削除の
 * 後の子・本体削除が失敗した場合はIntent行が残るため再埋め込みで回収できる。
 * 次にmatch_candidates(intent_a/bに含む行)・group_candidates(intent_idsに含む行)・
 * match_events(当該Intentの行)を先に削除してから本体を削除する
 * (子行がintentsをFK参照するため)。
 * イベント型のintent_deleted等はF3では投入しない(削除はdocs/06 §1のとおり層を経ず
 * 即時処理し、05 §2.2の列挙値はF4以降のために予約)。期限切れIntentのベクトル削除は
 * 別途Cronの2窓走査(docs/05 §2.6)
 */
intentRoutes.delete("/:id", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	// 所有確認(他人の・存在しないIntentは一律404・存在を隠す)。所有確認を先に
	// 行うのは、404の応答で他人のイベント投入記録に触れないようにするため
	const [target] = await db
		.select({ id: intents.id })
		.from(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)));
	if (target === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	// ベクトルを先に削除する(docs/05 §2.5の無条件削除)。失敗時はD1に触れず
	// 500 INTERNALで中止する(クライアントが再試行できる)。pause/resumeの
	// metadata同期と違い、削除はベストエフォートにしない(孤立ベクトルは
	// 他の評価のhitに現れたときにしか消えないため・#20の自己修復は安全網)
	const vectorStartedAt = systemClock.now().getTime();
	try {
		await createVectorStore(c.env).deleteByIds([target.id]);
	} catch (error) {
		logger.error("intents.delete.vector_failed", {
			intent_id: target.id,
			error_code: errorCodeOf(error),
		});
		const r = errorJson(
			"INTERNAL",
			"削除に失敗しました。時間を置いて再度お試しください",
		);
		return c.json(r.body, r.status);
	} finally {
		logDeleteTiming(target.id, "vector", vectorStartedAt);
	}
	// このIntentを含む進行中の提案を取り消す(docs/01 §8の不成立経路「参加Intentが削除された」)。
	// matchedは成立済みのため変更しない(docs/05 §2.5)。閉じるのは候補・イベント行の削除より前
	const deleteNow = systemClock.now();
	const closedLatchIds = await cancelOpenLatches(
		db,
		await openLatchIdsOfIntent(db, target.id),
		sub,
		deleteNow,
	);
	const childrenStartedAt = systemClock.now().getTime();
	// 子(候補・イベント投入記録)を先に削除してから本体を削除する(docs/05 §2.5)。
	// 1対1候補はintent_a/bのどちらかに含む行・グループ候補はintent_idsに含む行
	await db
		.delete(matchCandidates)
		.where(
			or(
				eq(matchCandidates.intentAId, target.id),
				eq(matchCandidates.intentBId, target.id),
			),
		);
	// intent_idsはJSON配列列のため、json_eachで展開した要素の一致で絞り込む
	await db
		.delete(groupCandidates)
		.where(
			sql`EXISTS (SELECT 1 FROM json_each(${groupCandidates.intentIds}) WHERE json_each.value = ${target.id})`,
		);
	await db.delete(matchEvents).where(eq(matchEvents.sourceIntentId, target.id));
	// 期限切れの通知(intent_expired)も消す(F7b設計 §5.7。対象が消えた通知を残さない)
	await db.delete(notifications).where(eq(notifications.intentId, target.id));
	logDeleteTiming(target.id, "d1_children", childrenStartedAt);
	const intentStartedAt = systemClock.now().getTime();
	const [deleted] = await db
		.delete(intents)
		.where(and(eq(intents.id, target.id), eq(intents.userId, sub)))
		.returning();
	logDeleteTiming(target.id, "d1_intent", intentStartedAt);
	// 次集合の提案はIntent行とそのグループ候補を消した後に行う(削除中のIntentを含む集合を
	// 提案しない・F4b設計 §3.5)。消えた行は版の照合・再検証(recheckSet)で除かれる
	await proposeNextGroupsAfterCancel(db, closedLatchIds, deleteNow);
	if (deleted === undefined) {
		// 所有確認後の並行削除。消えていれば同じ404(冪等な結果)。
		// ベクトルは先行して削除済みだが、行も無いため孤立にはならない
		const r = notFound();
		return c.json(r.body, r.status);
	}
	logger.info("intents.deleted", { intent_id: deleted.id });
	return c.body(null, 204);
});

/**
 * POST /v1/intents/{id}/pause(一時停止・docs/05 §3.2)。activeのみ実行可
 * (draft・paused等は400 invalid_status)。status=paused・version+1・期限は不変。
 * pausedはLayer 2 Candidate Retrievalの新規候補化を停止する(docs/06)。
 * 他人の・存在しないは一律404(存在を隠す・docs/05 §3.1)
 */
intentRoutes.post("/:id/pause", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const [row] = await db
		.select()
		.from(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)));
	if (row === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	if (row.status !== "active") {
		logger.warn("intents.pause.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"預けている(active)Intentのみ一時停止できます",
			{ reasons: ["invalid_status"] },
		);
		return c.json(r.body, r.status);
	}
	const result = await updateWithOptimisticLock(db, row, sub, {
		status: "paused",
		// 遷移ごとにversion+1(docs/01 §16)
		version: row.version + 1,
		updatedAt: systemClock.now(),
	});
	if (result.kind !== "ok") {
		if (result.kind === "version_conflict") {
			logger.warn("intents.pause.conflict", {
				error_code: "VALIDATION_FAILED",
			});
		}
		const r = guardedUpdateFailure(result.kind);
		return c.json(r.body, r.status);
	}
	// Vectorize metadataのstatusをpausedへ即時同期(docs/06 §2)。新規候補化を止める。
	// 失敗はベストエフォート(Cronのバックフィルで回収)のため応答は成功のまま
	await syncVectorStatus(c.env, result.row.id, "paused");
	logger.info("intents.paused", {
		intent_id: result.row.id,
		status: result.row.status,
		version: result.row.version,
	});
	return c.json(toIntentDto(result.row), 200);
});

/**
 * POST /v1/intents/{id}/resume(再開・docs/05 §3.2)。pausedのみ実行可
 * (active・draft等は400 invalid_status)。期限切れ(expires_at<=now)は400
 * (行のexpired遷移自体はF3のCronが行うため、ここでは再開だけを拒否する)。
 * 再開はactiveへの復帰と同じ扱いのため、Active Intent上限(5件)検証を行い
 * 超過は422 ACTIVE_INTENT_LIMIT(docs/05 §3.1)。status=active・version+1・
 * 期限は据え置き(再計算しない)。他人の・存在しないは一律404
 */
intentRoutes.post("/:id/resume", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const db = dbOf(c.env);
	const now = systemClock.now();
	const [row] = await db
		.select()
		.from(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)));
	if (row === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	if (row.status !== "paused") {
		logger.warn("intents.resume.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"一時停止中(paused)のIntentのみ再開できます",
			{ reasons: ["invalid_status"] },
		);
		return c.json(r.body, r.status);
	}
	// 期限切れの再開は不可。expiredへの遷移自体はF3のCron(docs/05 §2.2)
	if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
		logger.warn("intents.resume.rejected", { error_code: "VALIDATION_FAILED" });
		const r = errorJson(
			"VALIDATION_FAILED",
			"期限切れのIntentは再開できません",
			{ reasons: ["expired"] },
		);
		return c.json(r.body, r.status);
	}
	// 参加中active数の上限(作成・active化と同じ検証・上限5件・docs/05 §3.1)
	const [counted] = await db
		.select({ value: count() })
		.from(intents)
		.where(and(eq(intents.userId, sub), eq(intents.status, "active")));
	if ((counted?.value ?? 0) >= LIMITS.ACTIVE_INTENTS_PER_USER) {
		logger.warn("intents.resume.rejected", {
			error_code: "ACTIVE_INTENT_LIMIT",
		});
		const r = errorJson(
			"ACTIVE_INTENT_LIMIT",
			"参加中のIntentが上限に達しています。既存のIntentを見直してください",
		);
		return c.json(r.body, r.status);
	}
	const result = await updateWithOptimisticLock(db, row, sub, {
		status: "active",
		// 遷移ごとにversion+1(docs/01 §16)
		version: row.version + 1,
		updatedAt: now,
	});
	if (result.kind !== "ok") {
		if (result.kind === "version_conflict") {
			logger.warn("intents.resume.conflict", {
				error_code: "VALIDATION_FAILED",
			});
		}
		const r = guardedUpdateFailure(result.kind);
		return c.json(r.body, r.status);
	}
	// Vectorize metadataのstatusをactiveへ戻す(docs/06 §2)。失敗はベストエフォート
	// (Cronのバックフィルで回収)のため応答は成功のまま
	await syncVectorStatus(c.env, result.row.id, "active");
	// イベント発行(docs/06 §2「resumeはintent_updatedイベントを発行して再評価する」)。
	// 即時投入・versionは再開後の値。waitUntilでsendし、応答をブロックしない
	c.executionCtx.waitUntil(
		emitMatchEvent(
			c.env,
			{
				eventType: "intent_updated",
				intentId: result.row.id,
				version: result.row.version,
			},
			undefined,
			systemClock,
		),
	);
	logger.info("intents.resumed", {
		intent_id: result.row.id,
		status: result.row.status,
		version: result.row.version,
	});
	return c.json(toIntentDto(result.row), 200);
});
