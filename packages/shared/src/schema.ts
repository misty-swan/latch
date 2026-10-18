import { z } from "zod";
import {
	AUTH_PROVIDERS,
	BUDGET_MAX,
	CATEGORIES,
	CONSTRAINT_ITEM_MAX_LENGTH,
	CONSTRAINT_MAX_ITEMS,
	ERROR_CODES,
	GEO_RADIUS_MAX_M,
	GEO_RADIUS_MIN_M,
	INTENT_FORMS,
	INTENT_STATUSES,
	LIMITS,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
} from "./constants";

export const intentFormSchema = z.enum(INTENT_FORMS);
export const categorySchema = z.enum(CATEGORIES);
export const errorCodeSchema = z.enum(ERROR_CODES);

/** 認証プロバイダ。docs/05 §2.2(users.auth_provider) */
export const authProviderSchema = z.enum(AUTH_PROVIDERS);

/** POST /v1/auth/token のリクエスト(IdPトークン検証+JWT発行)。docs/05 §3.2 */
export const authTokenRequestSchema = z.object({
	provider: authProviderSchema,
	idp_token: z.string().min(1),
});

/** POST /v1/auth/refresh のリクエスト(回転式)。docs/05 §3.2・04 §5 */
export const refreshRequestSchema = z.object({
	refresh_token: z.string().min(1),
});

/** POST /v1/auth/logout のリクエスト(refresh_tokenは任意)。docs/05 §3.2 */
export const logoutRequestSchema = z.object({
	refresh_token: z.string().min(1).optional(),
});

/**
 * 生年月日('YYYY-MM-DD'書式+実在日付)。
 * 正規表現で書式を固定してからDateの往復一致で実在性を見る
 * (2026-02-30等の不在日を拒否し、うるう年のみ正当な2/29を通す)。
 * docs/05 §2.2(users.birth_date・自己申告・非公開)
 */
export const birthDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => {
		const date = new Date(s);
		return (
			!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s
		);
	});

/** POST /v1/users(初回登録)のリクエスト。docs/05 §3.2・§2.2(users) */
export const registerUserRequestSchema = z.object({
	display_name: z.string().trim().min(1).max(LIMITS.DISPLAY_NAME_MAX_LENGTH),
	birth_date: birthDateSchema,
	bio: z.string().max(LIMITS.BIO_MAX_LENGTH).default(""),
});

/** PATCH /v1/users/me のリクエスト(部分更新・1フィールド以上必須)。docs/05 §3.2 */
export const patchMeRequestSchema = z
	.object({
		display_name: z
			.string()
			.trim()
			.min(1)
			.max(LIMITS.DISPLAY_NAME_MAX_LENGTH)
			.optional(),
		bio: z.string().max(LIMITS.BIO_MAX_LENGTH).optional(),
	})
	.refine(
		(v) => v.display_name !== undefined || v.bio !== undefined,
		"display_name・bioのいずれか1フィールドは必須です",
	);

/** ユーザーのDTO(worker→webの応答の正)。docs/05 §2.2(users)・§3.3 */
export const userDtoSchema = z.object({
	id: z.string().length(26),
	display_name: z.string(),
	bio: z.string(),
	/** R2にアイコンを持つか(icon_keyの有無。URL生成はAPIが担う) */
	has_icon: z.boolean(),
});
export type UserDTO = z.infer<typeof userDtoSchema>;

/** Intentの状態。docs/05 §2.2(intents.status) */
export const intentStatusSchema = z.enum(INTENT_STATUSES);

/** アプリ内通知の受け取りレベル。docs/05 §2.2(notification_level・既定proposals_only) */
export const notificationLevelSchema = z.enum(["proposals_only", "muted"]);

/** ISO 8601日時(オフセット必須・Zも可)。docs/05 §2.2(datetime列) */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** parse応答のwarnings要素(判定不能NG条件の注意表示)。docs/05 §3.3 */
export const warningSchema = z.object({
	field: z.string(),
	note: z.string(),
});

/** 参加人数(2〜4人・min<=max)。docs/05 §2.2(participants_*)・06 */
export const participantsSchema = z
	.object({
		min: z.number().int().min(PARTICIPANTS_MIN).max(PARTICIPANTS_MAX),
		max: z.number().int().min(PARTICIPANTS_MIN).max(PARTICIPANTS_MAX),
		includes_owner: z.boolean(),
	})
	.refine((v) => v.min <= v.max, "minはmax以下である必要があります");

/** 地域添付(中心座標+半径m)。docs/05 §2.2(geo_*)・04(地理の実装) */
export const geoSchema = z.object({
	center: z.object({
		lat: z.number().min(-90).max(90),
		lng: z.number().min(-180).max(180),
	}),
	radius_m: z.number().int().min(GEO_RADIUS_MIN_M).max(GEO_RADIUS_MAX_M),
});

/** 予算(0〜上限円・min<=max・通貨はJPY固定)。docs/05 §2.2(budget_*) */
export const budgetSchema = z
	.object({
		min: z.number().int().min(0).max(BUDGET_MAX),
		max: z.number().int().min(0).max(BUDGET_MAX),
		currency: z.literal("JPY").default("JPY"),
	})
	.refine((v) => v.min <= v.max, "minはmax以下である必要があります");

/** 制約(ハード/ソフト/否定共通)。1項目40字まで・最大10項目。docs/05 §2.2(*_constraints) */
export const constraintsSchema = z
	.array(z.string().trim().min(1).max(CONSTRAINT_ITEM_MAX_LENGTH))
	.max(CONSTRAINT_MAX_ITEMS);

/** 時間帯(end省略時null・指定時はstartより後)。docs/05 §2.2(starts_at/ends_at) */
export const timeSchema = z
	.object({
		start: isoDateTimeSchema,
		end: isoDateTimeSchema.nullable().default(null),
	})
	.refine(
		(v) =>
			v.end === null || new Date(v.end).getTime() > new Date(v.start).getTime(),
		"endはstartより後である必要があります",
	);

/** POST /v1/intents/parse のリクエスト。docs/05 §3.2 */
export const parseIntentRequestSchema = z.object({
	raw_text: z.string().min(1).max(LIMITS.RAW_TEXT_MAX_LENGTH),
});

/** POST /v1/intents/parse の応答(構造化プレビュー・保存しない)。docs/05 §3.3 */
export const parseResponseSchema = z.object({
	form: intentFormSchema,
	topic: z.string(),
	category: categorySchema.nullable(),
	time: z
		.object({
			start: isoDateTimeSchema,
			end: isoDateTimeSchema.nullable(),
		})
		.nullable(),
	geo: geoSchema.nullable(),
	participants: participantsSchema,
	budget: budgetSchema.nullable(),
	expires_at_options: z.array(isoDateTimeSchema),
	alcohol_involved: z.boolean(),
	warnings: z.array(warningSchema),
});
export type ParseIntentResponse = z.infer<typeof parseResponseSchema>;

/**
 * Intentの可変フィールド群。createは既定値付きで・patchは全optional・
 * 既定値なしで使う(重複定義を避けるため共用)。docs/05 §3.2
 */
const intentMutableFieldsSchema = z.object({
	form: intentFormSchema.optional(),
	topic: z.string().trim().min(1).max(LIMITS.TOPIC_MAX_LENGTH).optional(),
	category: categorySchema.nullable().optional(),
	time: timeSchema.nullable().optional(),
	geo: geoSchema.nullable().optional(),
	participants: participantsSchema.optional(),
	budget: budgetSchema.nullable().optional(),
	hard_constraints: constraintsSchema.optional(),
	soft_constraints: constraintsSchema.optional(),
	negative_constraints: constraintsSchema.optional(),
	notification_level: notificationLevelSchema.optional(),
	alcohol_involved: z.boolean().optional(),
	expires_in_days: z
		.union([z.literal(7), z.literal(30), z.literal(90)])
		.optional(),
	expires_at: isoDateTimeSchema.optional(),
});

/** POST /v1/intents のリクエスト。docs/05 §3.2・§2.2(draftはraw_textのみで保存可) */
export const createIntentRequestSchema = intentMutableFieldsSchema.extend({
	raw_text: z.string().max(LIMITS.RAW_TEXT_MAX_LENGTH),
	status: z.enum(["draft", "active"]).default("active"),
	participants: participantsSchema.default({
		min: 2,
		max: 2,
		includes_owner: true,
	}),
	hard_constraints: constraintsSchema.default([]),
	soft_constraints: constraintsSchema.default([]),
	negative_constraints: constraintsSchema.default([]),
	notification_level: notificationLevelSchema.default("proposals_only"),
	alcohol_involved: z.boolean().default(false),
});

/** PATCH /v1/intents/{id} のリクエスト(部分更新・1フィールド以上必須)。docs/05 §3.2 */
export const patchIntentRequestSchema = intentMutableFieldsSchema
	.extend({
		raw_text: z.string().max(LIMITS.RAW_TEXT_MAX_LENGTH).optional(),
		status: z.enum(["draft", "active"]).optional(),
	})
	.refine(
		(v) => Object.values(v).some((field) => field !== undefined),
		"更新するフィールドを1つ以上指定してください",
	);

/** IntentのDTO(worker→webの応答の正)。docs/05 §2.2(intents)・§3.3 */
export const intentDtoSchema = z.object({
	id: z.string().length(26),
	form: intentFormSchema.nullable(),
	topic: z.string().nullable(),
	category: categorySchema.nullable(),
	raw_text: z.string(),
	time: z
		.object({
			start: isoDateTimeSchema,
			end: isoDateTimeSchema.nullable(),
		})
		.nullable(),
	geo: geoSchema.nullable(),
	participants: participantsSchema,
	budget: z
		.object({
			min: z.number().int().min(0).max(BUDGET_MAX),
			max: z.number().int().min(0).max(BUDGET_MAX),
			currency: z.literal("JPY"),
		})
		.nullable(),
	hard_constraints: z.array(z.string()),
	soft_constraints: z.array(z.string()),
	negative_constraints: z.array(z.string()),
	visibility: z.literal("hidden_until_match"),
	notification_level: notificationLevelSchema,
	alcohol_involved: z.boolean(),
	status: intentStatusSchema,
	version: z.number().int().min(1),
	expires_at: isoDateTimeSchema.nullable(),
	created_at: isoDateTimeSchema,
	updated_at: isoDateTimeSchema,
});
export type IntentDTO = z.infer<typeof intentDtoSchema>;
