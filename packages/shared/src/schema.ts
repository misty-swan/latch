import { z } from "zod";
import {
	AUTH_PROVIDERS,
	CATEGORIES,
	ERROR_CODES,
	INTENT_FORMS,
	LIMITS,
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
