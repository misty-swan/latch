/**
 * Intent APIルートのうち構造化プレビューと作成(docs/05 §3.2: POST /v1/intents/parse・
 * POST /v1/intents)。一覧・取得・更新・削除・pause/resumeは後続タスクでこのファイルに追加する。
 * - POST /v1/intents/parse: raw_textをParser(docs/07 §2)で構造化して応答する。保存しない。
 *   geoは解決しないため常にnull・participants.includes_ownerはtrue・budgetの通貨はJPY固定
 * - POST /v1/intents: draft=意味検証なしで保存(version=1・expires_at=null可) /
 *   active=validateIntentForActive(違反は400・details.reasons)→参加中active数が上限
 *   (LIMITS.ACTIVE_INTENTS_PER_USER)以上なら422 ACTIVE_INTENT_LIMIT→期限を確定して保存。
 *   visibilityは"hidden_until_match"固定でリクエストでは受けない(docs/01 §21)
 * エラー応答はdocs/05 §3.1の共通形状(errorJson)のみ。
 * 時刻の規律(docs/04 §4): ルートは合成の起点(composition root)のためsystemClockをimportして使う
 */

import {
	createIntentRequestSchema,
	type IntentDTO,
	LIMITS,
	type ParseIntentResponse,
	parseIntentRequestSchema,
} from "@latch/shared";
import { and, count, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, requireRegistered } from "../auth/middleware";
import { systemClock } from "../clock/clock";
import { intents } from "../db/schema";
import type { Env } from "../env";
import { errorJson } from "../http/errors";
import { newUlid } from "../ids";
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
		const r = errorJson(
			"UNAUTHORIZED",
			"この操作には登録済みユーザーのアクセストークンが必要です",
		);
		return c.json(r.body, r.status);
	}
	const d = parsed.data;
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
