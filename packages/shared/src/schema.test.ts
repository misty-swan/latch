import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_HTTP_STATUS, LIMITS } from "./constants";
import {
	authProviderSchema,
	authTokenRequestSchema,
	birthDateSchema,
	categorySchema,
	intentFormSchema,
	logoutRequestSchema,
	patchMeRequestSchema,
	refreshRequestSchema,
	registerUserRequestSchema,
	userDtoSchema,
} from "./schema";

describe("intentFormSchema", () => {
	it("connection を受理する", () => {
		expect(intentFormSchema.parse("connection")).toBe("connection");
	});

	it("未定義のフォーム friendship を拒否する", () => {
		expect(intentFormSchema.safeParse("friendship").success).toBe(false);
	});
});

describe("categorySchema", () => {
	it("「その他」を受理する", () => {
		expect(categorySchema.safeParse("その他").success).toBe(true);
	});

	it("未定義のカテゴリ「旅行」を拒否する(「旅行・アウトドア」とは部分一致しない)", () => {
		expect(categorySchema.safeParse("旅行").success).toBe(false);
	});
});

describe("authProviderSchema", () => {
	it("google・appleを受理する", () => {
		expect(authProviderSchema.safeParse("google").success).toBe(true);
		expect(authProviderSchema.safeParse("apple").success).toBe(true);
	});

	it('provider不正な値("x")を拒否する', () => {
		expect(authProviderSchema.safeParse("x").success).toBe(false);
	});
});

describe("authTokenRequestSchema", () => {
	it("provider・idp_tokenが正しければ受理する", () => {
		expect(
			authTokenRequestSchema.safeParse({
				provider: "google",
				idp_token: "idp-token",
			}).success,
		).toBe(true);
	});

	it('provider不正な値("x")なら拒否する', () => {
		expect(
			authTokenRequestSchema.safeParse({
				provider: "x",
				idp_token: "idp-token",
			}).success,
		).toBe(false);
	});

	it("idp_tokenが空なら拒否する", () => {
		expect(
			authTokenRequestSchema.safeParse({ provider: "apple", idp_token: "" })
				.success,
		).toBe(false);
	});
});

describe("refreshRequestSchema", () => {
	it("refresh_tokenが空なら拒否する", () => {
		expect(refreshRequestSchema.safeParse({ refresh_token: "" }).success).toBe(
			false,
		);
	});
});

describe("logoutRequestSchema", () => {
	it("refresh_tokenがなくても受理する(任意)", () => {
		expect(logoutRequestSchema.safeParse({}).success).toBe(true);
	});

	it("refresh_tokenが空なら拒否する", () => {
		expect(logoutRequestSchema.safeParse({ refresh_token: "" }).success).toBe(
			false,
		);
	});
});

describe("birthDateSchema", () => {
	it("YYYY-MM-DD書式の実在日付を受理する", () => {
		expect(birthDateSchema.safeParse("2000-01-15").success).toBe(true);
	});

	it("うるう年のみ正当な2月29日を通す", () => {
		expect(birthDateSchema.safeParse("2024-02-29").success).toBe(true);
		expect(birthDateSchema.safeParse("2026-02-29").success).toBe(false);
	});

	it("実在しない日付(2026-02-30)を拒否する", () => {
		expect(birthDateSchema.safeParse("2026-02-30").success).toBe(false);
	});

	it("書式が崩れた入力を拒否する", () => {
		expect(birthDateSchema.safeParse("2000/01/15").success).toBe(false);
		expect(birthDateSchema.safeParse("2000-1-15").success).toBe(false);
	});
});

describe("registerUserRequestSchema", () => {
	const base = { display_name: "表示名", birth_date: "2000-01-15" };

	it("bio省略で受理し、既定値は空文字", () => {
		const parsed = registerUserRequestSchema.parse({ ...base });
		expect(parsed.bio).toBe("");
	});

	it("display_nameはtrim後1字以上40字以内", () => {
		expect(
			registerUserRequestSchema.safeParse({
				...base,
				display_name: "　",
			}).success,
		).toBe(false);
		expect(
			registerUserRequestSchema.safeParse({
				...base,
				display_name: "あ".repeat(41),
			}).success,
		).toBe(false);
		expect(
			registerUserRequestSchema.parse({ ...base, display_name: " 山田 " })
				.display_name,
		).toBe("山田");
	});

	it("bioは200字以内", () => {
		expect(
			registerUserRequestSchema.safeParse({
				...base,
				bio: "あ".repeat(201),
			}).success,
		).toBe(false);
	});

	it("birth_dateが実在しない日付なら拒否する", () => {
		expect(
			registerUserRequestSchema.safeParse({
				...base,
				birth_date: "2026-02-30",
			}).success,
		).toBe(false);
	});
});

describe("patchMeRequestSchema", () => {
	it("1フィールド以上なら受理する", () => {
		expect(
			patchMeRequestSchema.safeParse({ display_name: "表示名" }).success,
		).toBe(true);
		expect(patchMeRequestSchema.safeParse({ bio: "" }).success).toBe(true);
	});

	it("空オブジェクトは拒否する(1フィールド必須)", () => {
		expect(patchMeRequestSchema.safeParse({}).success).toBe(false);
	});

	it("display_name 41字・bio 201字は拒否する", () => {
		expect(
			patchMeRequestSchema.safeParse({ display_name: "あ".repeat(41) }).success,
		).toBe(false);
		expect(
			patchMeRequestSchema.safeParse({ bio: "あ".repeat(201) }).success,
		).toBe(false);
	});
});

describe("userDtoSchema", () => {
	const dto = {
		id: "A".repeat(26),
		display_name: "表示名",
		bio: "",
		has_icon: false,
	};

	it("has_iconを含むユーザーDTOを受理する", () => {
		expect(userDtoSchema.parse(dto)).toEqual(dto);
	});

	it("idが26文字でなければ拒否する", () => {
		expect(
			userDtoSchema.safeParse({ ...dto, id: "A".repeat(25) }).success,
		).toBe(false);
	});
});

describe("ERROR_HTTP_STATUS", () => {
	it("docs/05 §3.1の主要コードに対応するステータスを持つ", () => {
		expect(ERROR_HTTP_STATUS.UNAUTHORIZED).toBe(401);
		expect(ERROR_HTTP_STATUS.TOKEN_EXPIRED).toBe(401);
		expect(ERROR_HTTP_STATUS.VALIDATION_FAILED).toBe(400);
		expect(ERROR_HTTP_STATUS.UNDER_AGE).toBe(422);
		expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
		expect(ERROR_HTTP_STATUS.EMBEDDING_PENDING).toBe(409);
		expect(ERROR_HTTP_STATUS.INTERNAL).toBe(500);
	});

	it("13種のエラーコード全てを過不足なく網羅する", () => {
		expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual(
			[...ERROR_CODES].sort(),
		);
	});
});

describe("LIMITS", () => {
	it("ICON_MAX_BYTESは1MB(1_048_576)", () => {
		expect(LIMITS.ICON_MAX_BYTES).toBe(1_048_576);
	});
});
