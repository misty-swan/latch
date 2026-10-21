import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_HTTP_STATUS, LIMITS } from "./constants";
import {
	authProviderSchema,
	authTokenRequestSchema,
	birthDateSchema,
	blockDtoSchema,
	blockListResponseSchema,
	budgetSchema,
	categorySchema,
	chatClientFrameSchema,
	chatServerFrameSchema,
	clientIdSchema,
	constraintsSchema,
	createIntentRequestSchema,
	devIdpTokenRequestSchema,
	intentDtoSchema,
	intentFormSchema,
	isoDateTimeSchema,
	latchDtoSchema,
	logoutRequestSchema,
	markReadRequestSchema,
	messageBodySchema,
	messageDtoSchema,
	messagePageSchema,
	notificationDtoSchema,
	notificationListResponseSchema,
	notificationReadRequestSchema,
	parseIntentRequestSchema,
	parseResponseSchema,
	participantsSchema,
	patchIntentRequestSchema,
	patchMeRequestSchema,
	pushSubscriptionDeleteRequestSchema,
	pushSubscriptionRequestSchema,
	refreshRequestSchema,
	registerUserRequestSchema,
	reportCreateRequestSchema,
	sendMessageRequestSchema,
	timeSchema,
	userDtoSchema,
	wsTicketRequestSchema,
	wsTicketResponseSchema,
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

describe("devIdpTokenRequestSchema(F2' Task 2: dev専用サインイン)", () => {
	it("1字以上64字以下のsubjectを受理する", () => {
		expect(devIdpTokenRequestSchema.safeParse({ subject: "a" }).success).toBe(
			true,
		);
		expect(
			devIdpTokenRequestSchema.safeParse({ subject: "a".repeat(64) }).success,
		).toBe(true);
	});

	it("空文字・65字以上・非文字列のsubjectを拒否する", () => {
		expect(devIdpTokenRequestSchema.safeParse({ subject: "" }).success).toBe(
			false,
		);
		expect(
			devIdpTokenRequestSchema.safeParse({ subject: "a".repeat(65) }).success,
		).toBe(false);
		expect(devIdpTokenRequestSchema.safeParse({ subject: 1 }).success).toBe(
			false,
		);
		expect(devIdpTokenRequestSchema.safeParse({}).success).toBe(false);
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

describe("isoDateTimeSchema", () => {
	it("オフセット付きISO 8601を受理する(Z・+09:00の両方)", () => {
		expect(
			isoDateTimeSchema.safeParse("2026-10-18T09:00:00+09:00").success,
		).toBe(true);
		expect(isoDateTimeSchema.safeParse("2026-10-18T00:00:00Z").success).toBe(
			true,
		);
	});

	it("空白区切り・オフセット無しを拒否する", () => {
		expect(isoDateTimeSchema.safeParse("2026-10-18 09:00:00").success).toBe(
			false,
		);
		expect(isoDateTimeSchema.safeParse("2026-10-18T09:00:00").success).toBe(
			false,
		);
	});
});

describe("participantsSchema", () => {
	const base = { includes_owner: true };

	it("min=2・max=4を受理する", () => {
		expect(
			participantsSchema.safeParse({ min: 2, max: 4, ...base }).success,
		).toBe(true);
	});

	it("min=1・min=5は拒否する(2〜4人)", () => {
		expect(
			participantsSchema.safeParse({ min: 1, max: 2, ...base }).success,
		).toBe(false);
		expect(
			participantsSchema.safeParse({ min: 5, max: 5, ...base }).success,
		).toBe(false);
	});

	it("min>maxは拒否する", () => {
		expect(
			participantsSchema.safeParse({ min: 3, max: 2, ...base }).success,
		).toBe(false);
	});
});

describe("budgetSchema", () => {
	it("min>maxは拒否する", () => {
		expect(budgetSchema.safeParse({ min: 5000, max: 3000 }).success).toBe(
			false,
		);
	});

	it("currency未指定はJPYに既定化する", () => {
		expect(budgetSchema.parse({ min: 0, max: 5000 }).currency).toBe("JPY");
	});
});

describe("constraintsSchema", () => {
	it("10項目まで受理し11項目は拒否する", () => {
		expect(constraintsSchema.safeParse(Array(10).fill("条件")).success).toBe(
			true,
		);
		expect(constraintsSchema.safeParse(Array(11).fill("条件")).success).toBe(
			false,
		);
	});

	it("1項目は40字まで・41字は拒否する", () => {
		expect(constraintsSchema.safeParse(["あ".repeat(40)]).success).toBe(true);
		expect(constraintsSchema.safeParse(["あ".repeat(41)]).success).toBe(false);
	});
});

describe("timeSchema", () => {
	it("endがstartより前なら拒否する", () => {
		expect(
			timeSchema.safeParse({
				start: "2026-10-18T19:00:00+09:00",
				end: "2026-10-18T18:00:00+09:00",
			}).success,
		).toBe(false);
	});

	it("end省略時はnullに既定化する", () => {
		expect(timeSchema.parse({ start: "2026-10-18T19:00:00+09:00" }).end).toBe(
			null,
		);
	});
});

describe("parseIntentRequestSchema", () => {
	it("raw_textは1〜300字(空・301字は拒否)", () => {
		expect(parseIntentRequestSchema.safeParse({ raw_text: "" }).success).toBe(
			false,
		);
		expect(
			parseIntentRequestSchema.safeParse({ raw_text: "あ".repeat(301) })
				.success,
		).toBe(false);
		expect(
			parseIntentRequestSchema.safeParse({ raw_text: "飲みに行きたい" })
				.success,
		).toBe(true);
	});
});

describe("createIntentRequestSchema", () => {
	const base = { raw_text: "飲みに行きたい" };

	it("raw_textは0〜300字(301字は拒否・draft用の空文字は受理)", () => {
		expect(
			createIntentRequestSchema.safeParse({ raw_text: "あ".repeat(301) })
				.success,
		).toBe(false);
		expect(createIntentRequestSchema.safeParse({ raw_text: "" }).success).toBe(
			true,
		);
	});

	it("status未指定はactiveに既定化する", () => {
		expect(createIntentRequestSchema.parse({ ...base }).status).toBe("active");
	});

	it("topicはtrim後1字以上必須", () => {
		expect(
			createIntentRequestSchema.safeParse({ ...base, topic: "　" }).success,
		).toBe(false);
	});

	it("participants未指定は{min:2,max:2,includes_owner:true}", () => {
		expect(createIntentRequestSchema.parse({ ...base }).participants).toEqual({
			min: 2,
			max: 2,
			includes_owner: true,
		});
	});

	it("expires_in_daysは7・30・90のみ受理する(31は拒否)", () => {
		expect(
			createIntentRequestSchema.safeParse({ ...base, expires_in_days: 30 })
				.success,
		).toBe(true);
		expect(
			createIntentRequestSchema.safeParse({ ...base, expires_in_days: 31 })
				.success,
		).toBe(false);
	});
});

describe("patchIntentRequestSchema", () => {
	it("空オブジェクトは拒否する(1フィールド必須)", () => {
		expect(patchIntentRequestSchema.safeParse({}).success).toBe(false);
	});

	it("statusのみの指定を受理する", () => {
		expect(
			patchIntentRequestSchema.safeParse({ status: "active" }).success,
		).toBe(true);
	});

	it("既定値を埋めない(指定しないフィールドはundefinedのまま)", () => {
		const parsed = patchIntentRequestSchema.parse({ topic: "test" });
		expect(parsed.participants).toBeUndefined();
		expect(parsed.status).toBeUndefined();
	});
});

describe("parseResponseSchema", () => {
	const response = {
		form: "occasion",
		topic: "天文館で飲みに行く",
		category: "食・飲み",
		time: { start: "2026-10-18T20:00:00+09:00", end: null },
		geo: { center: { lat: 31.59, lng: 130.55 }, radius_m: 500 },
		participants: { min: 2, max: 4, includes_owner: true },
		budget: { min: 0, max: 5000, currency: "JPY" },
		expires_at_options: ["2026-10-25T20:00:00+09:00"],
		alcohol_involved: true,
		warnings: [
			{ field: "time", note: "終了時刻が不明のため既定値を当てはめました" },
		],
	};

	it("docs/05 §3.3の構造化プレビュー形状を受理する", () => {
		expect(parseResponseSchema.parse(response)).toEqual(response);
	});

	it("time・geo・budgetはnullを許す", () => {
		expect(
			parseResponseSchema.safeParse({
				...response,
				time: null,
				geo: null,
				budget: null,
			}).success,
		).toBe(true);
	});
});

describe("intentDtoSchema", () => {
	const dto = {
		id: "A".repeat(26),
		form: "occasion",
		topic: "天文館で飲みに行く",
		category: "食・飲み",
		raw_text: "今日20時以降、天文館周辺で飲みに行きたい",
		time: {
			start: "2026-10-18T20:00:00+09:00",
			end: "2026-10-18T22:00:00+09:00",
		},
		geo: null,
		participants: { min: 2, max: 4, includes_owner: true },
		budget: { min: 0, max: 5000, currency: "JPY" },
		hard_constraints: [],
		soft_constraints: [],
		negative_constraints: [],
		visibility: "hidden_until_match",
		notification_level: "proposals_only",
		alcohol_involved: true,
		status: "active",
		version: 1,
		expires_at: "2026-10-18T23:00:00+09:00",
		created_at: "2026-10-18T12:00:00+09:00",
		updated_at: "2026-10-18T12:00:00+09:00",
	};

	it("docs/05 §2.2のIntent DTOを受理する", () => {
		expect(intentDtoSchema.parse(dto)).toEqual(dto);
	});

	it("visibilityはhidden_until_matchのみ・versionは1以上", () => {
		expect(
			intentDtoSchema.safeParse({ ...dto, visibility: "public" }).success,
		).toBe(false);
		expect(intentDtoSchema.safeParse({ ...dto, version: 0 }).success).toBe(
			false,
		);
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

	it("14種のエラーコード全てを過不足なく網羅する", () => {
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

describe("チャットのスキーマ(F6a設計)", () => {
	const ulid = "01J0000000000000000000000A";
	const iso = "2026-10-21T00:00:00.000Z";

	it("本文は前後の空白を除いて保存形になる", () => {
		expect(messageBodySchema.parse("  こんにちは \n")).toBe("こんにちは");
	});
	it("空白だけ・2,001字はNG、2,000字はOK", () => {
		expect(messageBodySchema.safeParse(" \n ").success).toBe(false);
		expect(messageBodySchema.safeParse("a".repeat(2001)).success).toBe(false);
		expect(messageBodySchema.safeParse("a".repeat(2000)).success).toBe(true);
	});
	it("client_idは65字・空白入り・空文字がNG", () => {
		expect(clientIdSchema.safeParse("a".repeat(64)).success).toBe(true);
		expect(clientIdSchema.safeParse("a".repeat(65)).success).toBe(false);
		expect(clientIdSchema.safeParse("a b").success).toBe(false);
		expect(clientIdSchema.safeParse("").success).toBe(false);
	});
	it("sendMessageRequestの余分なキーはNG", () => {
		expect(
			sendMessageRequestSchema.safeParse({ body: "hi", client_id: "c1" })
				.success,
		).toBe(true);
		expect(
			sendMessageRequestSchema.safeParse({ body: "hi", client_id: "c1", x: 1 })
				.success,
		).toBe(false);
	});
	it("markReadRequestはULIDを要求する", () => {
		expect(
			markReadRequestSchema.safeParse({ last_read_message_id: ulid }).success,
		).toBe(true);
		expect(
			markReadRequestSchema.safeParse({ last_read_message_id: "x" }).success,
		).toBe(false);
	});
	it("wsTicketRequestのscopeがchat以外はNG", () => {
		expect(
			wsTicketRequestSchema.safeParse({ scope: "chat", latch_id: ulid })
				.success,
		).toBe(true);
		expect(
			wsTicketRequestSchema.safeParse({ scope: "other", latch_id: ulid })
				.success,
		).toBe(false);
	});
	it("wsTicketResponseのexpires_inは60", () => {
		expect(
			wsTicketResponseSchema.safeParse({ ticket: "t", expires_in: 60 }).success,
		).toBe(true);
		expect(
			wsTicketResponseSchema.safeParse({ ticket: "t", expires_in: 30 }).success,
		).toBe(false);
	});
	it("messageDto・messagePageが通る", () => {
		const m = {
			id: ulid,
			user_id: "u",
			body: "b",
			created_at: iso,
			client_id: null,
		};
		expect(messageDtoSchema.safeParse(m).success).toBe(true);
		expect(
			messagePageSchema.safeParse({ items: [m], next_before: null }).success,
		).toBe(true);
	});
	it("chatClientFrameはmessage型だけ", () => {
		expect(
			chatClientFrameSchema.safeParse({
				type: "message",
				body: " hi ",
				client_id: "c",
			}).success,
		).toBe(true);
		expect(
			chatClientFrameSchema.safeParse({
				type: "ping",
				body: "hi",
				client_id: "c",
			}).success,
		).toBe(false);
	});
	it("chatServerFrameのerrorはcodeが3種以外NG", () => {
		for (const code of ["read_only", "invalid_message", "internal"]) {
			expect(
				chatServerFrameSchema.safeParse({
					type: "error",
					code,
					client_id: null,
				}).success,
			).toBe(true);
		}
		expect(
			chatServerFrameSchema.safeParse({
				type: "error",
				code: "nope",
				client_id: null,
			}).success,
		).toBe(false);
	});
	it("chatServerFrameのmessageとclosedが通る", () => {
		expect(
			chatServerFrameSchema.safeParse({
				type: "message",
				id: ulid,
				user_id: "u",
				body: "b",
				created_at: iso,
				client_id: null,
			}).success,
		).toBe(true);
		expect(chatServerFrameSchema.safeParse({ type: "closed" }).success).toBe(
			true,
		);
	});
	it("latchDtoSchemaはlast_message・unread_countなしでもあっても通る", () => {
		const base = {
			id: ulid,
			form: "connection",
			status: "matched",
			response_deadline: iso,
			participants_count: 2,
			my_response: "yes",
			score: 0.5,
			my_intent_id: null,
			matched_at: iso,
		};
		expect(latchDtoSchema.safeParse(base).success).toBe(true);
		expect(
			latchDtoSchema.safeParse({
				...base,
				last_message: { body: "b", created_at: iso, user_id: "u" },
				unread_count: 3,
			}).success,
		).toBe(true);
		expect(
			latchDtoSchema.safeParse({ ...base, last_message: null }).success,
		).toBe(true);
		expect(
			latchDtoSchema.safeParse({ ...base, unread_count: -1 }).success,
		).toBe(false);
	});
});

describe("reportCreateRequestSchema", () => {
	const L = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
	const base = { latch_id: L, target: "proposal", reason: "spam" };
	it("target=proposalでnote無しを受理する", () => {
		expect(reportCreateRequestSchema.safeParse(base).success).toBe(true);
	});
	it("noteの前後の空白を除く", () => {
		const r = reportCreateRequestSchema.parse({ ...base, note: "  あ  " });
		expect(r.note).toBe("あ");
	});
	it("note 500字は受理・501字は拒否する", () => {
		expect(
			reportCreateRequestSchema.safeParse({ ...base, note: "あ".repeat(500) })
				.success,
		).toBe(true);
		expect(
			reportCreateRequestSchema.safeParse({ ...base, note: "あ".repeat(501) })
				.success,
		).toBe(false);
	});
	it("未知のtarget・未知のキーを拒否する", () => {
		expect(
			reportCreateRequestSchema.safeParse({ ...base, target: "other" }).success,
		).toBe(false);
		expect(
			reportCreateRequestSchema.safeParse({ ...base, extra: 1 }).success,
		).toBe(false);
	});
});

describe("blockDtoSchema / blockListResponseSchema", () => {
	it("ブロック一覧の形を受理する", () => {
		const b = {
			user_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
			display_name: "a",
			has_icon: false,
			created_at: "2026-10-21T00:00:00.000Z",
		};
		expect(blockDtoSchema.safeParse(b).success).toBe(true);
		expect(blockListResponseSchema.safeParse({ blocks: [b] }).success).toBe(
			true,
		);
	});
});

describe("通知のスキーマ(F7b設計)", () => {
	const common = {
		id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
		read_at: null,
		created_at: "2026-10-21T00:00:00.000Z",
	};
	it("4種のnotificationDtoを受理し、一覧応答を受理する", () => {
		const items = [
			{
				...common,
				type: "proposal",
				latch_id: common.id,
				response_deadline: "2026-10-22T00:00:00.000Z",
			},
			{
				...common,
				type: "matched",
				latch_id: common.id,
				display_names: ["a", "b"],
			},
			{ ...common, type: "closed", latch_id: common.id },
			{
				...common,
				type: "intent_expired",
				intent: { id: common.id, raw_text: "text" },
			},
		];
		for (const item of items) {
			expect(notificationDtoSchema.safeParse(item).success).toBe(true);
		}
		expect(
			notificationListResponseSchema.safeParse({
				items,
				next_cursor: null,
				unread_count: 4,
			}).success,
		).toBe(true);
		expect(
			notificationDtoSchema.safeParse({ ...common, type: "system" }).success,
		).toBe(false);
	});
	it("既読リクエストはup_to_id(26字)だけを受理する", () => {
		expect(
			notificationReadRequestSchema.safeParse({ up_to_id: common.id }).success,
		).toBe(true);
		expect(
			notificationReadRequestSchema.safeParse({ up_to_id: "short" }).success,
		).toBe(false);
		expect(
			notificationReadRequestSchema.safeParse({
				up_to_id: common.id,
				extra: 1,
			}).success,
		).toBe(false);
	});
	it("購読リクエストはendpoint 1,024字まで・未知のキーを拒否する", () => {
		const keys = { p256dh: "p", auth: "a" };
		const url = (n: number) => `https://fcm.googleapis.com/${"a".repeat(n)}`;
		const base = "https://fcm.googleapis.com/".length;
		expect(
			pushSubscriptionRequestSchema.safeParse({
				endpoint: url(1024 - base),
				keys,
			}).success,
		).toBe(true);
		expect(
			pushSubscriptionRequestSchema.safeParse({
				endpoint: url(1025 - base),
				keys,
			}).success,
		).toBe(false);
		expect(
			pushSubscriptionRequestSchema.safeParse({
				endpoint: url(1),
				keys,
				extra: 1,
			}).success,
		).toBe(false);
		expect(
			pushSubscriptionDeleteRequestSchema.safeParse({ endpoint: url(1) })
				.success,
		).toBe(true);
		expect(
			pushSubscriptionDeleteRequestSchema.safeParse({
				endpoint: url(1),
				extra: 1,
			}).success,
		).toBe(false);
	});
});
