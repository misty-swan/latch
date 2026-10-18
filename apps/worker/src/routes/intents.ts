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
 * - DELETE /v1/intents/{id}: 削除(所有者のみ・他人は404)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点(composition root)のためsystemClockをimportして使う
 */

import {
	createIntentRequestSchema,
	type IntentDTO,
	type IntentStatus,
	intentStatusSchema,
	LIMITS,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
	type ParseIntentResponse,
	parseIntentRequestSchema,
	patchIntentRequestSchema,
} from "@latch/shared";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { intents } from "../db/schema";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { newUlid } from "../ids";
import { MS_PER_DAY } from "../intents/expiry";
import { validateIntentForActive } from "../intents/validation";
import { createLlm } from "../llm/mode";
import { createLogger } from "../logging/logger";

/** 構造化ロガー(docs/08 §6: 許可フィールドのみ)。raw_text・topic・座標は決して出力しない */
const logger = createLogger();

/** Intent APIのサブアプリ。index.tsが /v1/intents にマウントする(docs/05 §3.2) */
export const intentRoutes = new Hono<AppEnv>();

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

/** 404 NOT_FOUND。他人の・存在しないIntentは区別せず存在を隠す(docs/05 §3.1) */
const notFound = () => errorJson("NOT_FOUND", "Intentが見つかりません");

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

	// limit=1..50既定20(docs/05 §3.1)。範囲外・整数でない値は400
	let limit = 20;
	const limitParam = c.req.query("limit");
	if (limitParam !== undefined) {
		const parsedLimit = Number(limitParam);
		if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
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
	// (docs/05 §2.2)。time:nullの指定は現行値維持のため可
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

	// TODO(F3): topic等の意味フィールド変更時のEmbedding再計算イベント発行
	const [updated] = await db
		.update(intents)
		.set({
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
			budgetMin:
				d.budget === undefined ? row.budgetMin : (d.budget?.min ?? null),
			budgetMax:
				d.budget === undefined ? row.budgetMax : (d.budget?.max ?? null),
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
		})
		.where(and(eq(intents.id, row.id), eq(intents.userId, sub)))
		.returning();
	if (updated === undefined) {
		const r = errorJson("INTERNAL", "Intentの更新に失敗しました");
		return c.json(r.body, r.status);
	}
	logger.info("intents.updated", {
		intent_id: updated.id,
		status: updated.status,
		version: updated.version,
	});
	return c.json(toIntentDto(updated), 200);
});

/**
 * DELETE /v1/intents/{id}(削除・docs/05 §3.2)。所有者のみ・他人は404(存在を隠す)。
 * 所有者条件を含む1文のDELETE…RETURNINGで判定と削除を同時に行う
 */
intentRoutes.delete("/:id", requireRegistered, async (c) => {
	const sub = c.var.auth.sub;
	if (sub === undefined) {
		// requireRegisteredが保証する(到達しない・防御・docs/05 §3.1)
		const r = unauthorizedForRegistered();
		return c.json(r.body, r.status);
	}
	const [deleted] = await dbOf(c.env)
		.delete(intents)
		.where(and(eq(intents.id, c.req.param("id")), eq(intents.userId, sub)))
		.returning();
	if (deleted === undefined) {
		const r = notFound();
		return c.json(r.body, r.status);
	}
	// TODO(F3): VectorizeからこのIntentのベクトルを削除する
	// TODO(F4): このIntentが参加する提案のcancelled連鎖
	logger.info("intents.deleted", { intent_id: deleted.id });
	return c.body(null, 204);
});
