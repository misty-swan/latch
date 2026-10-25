/**
 * D1スキーマの正本。テーブル・列・UNIQUE・INDEXの定義は docs/05 §2(データモデル)。
 * §2.1の23テーブルを過不足なく写す。
 *
 * 写像規約(F0計画で固定・docs/05冒頭「Drizzleスキーマへの写像は実装が担う」の実装決定):
 * - ULID = text(26) 主キー
 * - 時刻 = integer timestamp_ms(UTC)・DB既定値なし(挿入時clock由来の設計)
 * - birth_date = text('YYYY-MM-DD')
 * - 論理値 = integer boolean / JSON = text json-mode
 * - 列挙 = text + $type<union>(CHECK制約は付けない・検証はZod層=packages/shared)
 * - FKは docs/05 §2.2の「FK」表記どおり references() を付け、ON DELETE は付けない
 *   (削除は常にアプリ層の明示操作・docs/05 §2.5)。例外はrecent_vectors(意思の削除で
 *   一緒に消える控えのためON DELETE CASCADE・#47)
 */
import type {
	AuthProvider,
	Category,
	CounterScope,
	IntentForm,
	IntentStatus,
	LatchResponseValue,
	LatchStatus,
	MatchEventType,
	NotificationType,
	PushState,
} from "@latch/shared";
import {
	blob,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 認証プロバイダの正本は@latch/shared。他参照の互換のため再exportする */
export type { AuthProvider } from "@latch/shared";
/** ユーザー種別。v1.0はindividual固定(将来business・docs/01 §17) */
export type UserActorType = "individual";
/** ユーザーの状態。deleted=退会 */
export type UserStatus = "active" | "deleted";
/** リフレッシュトークン族の状態 */
export type RefreshFamilyStatus = "active" | "revoked";
/** visibility。v1.0はhidden_until_match単値(docs/01 §21) */
export type IntentVisibility = "hidden_until_match";
/** 通知レベル */
export type NotificationLevel = "proposals_only" | "muted";
/** マッチングイベントの処理状態。dead=DLQ隔離 */
export type MatchEventStatus = "pending" | "processed" | "failed" | "dead";
/** 1対1評価候補の状態 */
export type MatchCandidateStatus = "candidate" | "proposed" | "closed";
/** グループ評価候補の状態 */
export type GroupCandidateStatus = "candidate" | "proposed" | "closed";
/** 提案履歴の結果。matched/rejectedが恒久排除・deferred/expiredは機会Intentの条件付き再提案の参照に使う(docs/01 §8) */
export type ProposalOutcome =
	| "proposed"
	| "matched"
	| "rejected"
	| "expired"
	| "deferred";
/** 正解データ申告の種別(docs/01 §14) */
export type LatchFeedbackKind = "attendance" | "connection_quality";
/** 通報の理由 */
export type ReportReason = "spam" | "harassment" | "inappropriate" | "other";
/** 通報の対象(F7a設計 §3.2) */
export type ReportTarget = "proposal" | "profile" | "icon" | "message";
/** 通報の処理状態 */
export type ReportStatus = "open" | "resolved";
/** Web Push購読の状態 */
export type PushSubscriptionStatus = "active" | "failed";
/** 体感アンケートの種別(docs/01 §7) */
export type SurveyKind = "onboarding" | "week4";
/** 正解データの結果(docs/01 §14) */
export type CalibrationOutcome =
	| "both_yes"
	| "one_no"
	| "expired"
	| "cancelled";
/** 地名の種別 */
export type GeofeatureType = "city" | "station";

/** ユーザー */
export const users = sqliteTable(
	"users",
	{
		id: text("id", { length: 26 }).primaryKey(),
		authProvider: text("auth_provider").$type<AuthProvider>().notNull(),
		authSubject: text("auth_subject").notNull(),
		actorType: text("actor_type").$type<UserActorType>().notNull(),
		displayName: text("display_name").notNull(),
		bio: text("bio").notNull(),
		/** R2オブジェクトキー。null=既定アバター */
		iconKey: text("icon_key"),
		/** 自己申告・非公開(18歳検証のみ)。'YYYY-MM-DD' */
		birthDate: text("birth_date").notNull(),
		status: text("status").$type<UserStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("users_auth_provider_auth_subject_uniq").on(
			t.authProvider,
			t.authSubject,
		),
	],
);

/** リフレッシュトークン族(回転式)。再利用検出は族revoked+401(docs/04 §4) */
export const refreshFamilies = sqliteTable(
	"refresh_families",
	{
		id: text("id", { length: 26 }).primaryKey(),
		userId: text("user_id", { length: 26 })
			.notNull()
			.references(() => users.id),
		/** 現行リフレッシュトークンのハッシュ(SHA-256) */
		currentHash: text("current_hash").notNull(),
		/** 直前の現行トークンハッシュ。再利用検出で族を特定する(docs/05 §2.2) */
		previousHash: text("previous_hash"),
		/** 30日(回転ごとに延長) */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		status: text("status").$type<RefreshFamilyStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [uniqueIndex("refresh_families_current_hash_uniq").on(t.currentHash)],
);

/** Intent(意思本体) */
export const intents = sqliteTable(
	"intents",
	{
		id: text("id", { length: 26 }).primaryKey(),
		userId: text("user_id", { length: 26 })
			.notNull()
			.references(() => users.id),
		/** draft保存ではnull許容(docs/05 §2.2の制約)。active化時に検証 */
		form: text("form").$type<IntentForm>(),
		/** 主題の短句(1..40)。draft保存ではnull許容 */
		topic: text("topic"),
		/** 低粒度タグ(任意・D-B-01初期セット) */
		category: text("category").$type<Category>(),
		/** 入力文(0..300) */
		rawText: text("raw_text").notNull(),
		/** 機会Intent=必須 / つながりIntent=null */
		startsAt: integer("starts_at", { mode: "timestamp_ms" }),
		endsAt: integer("ends_at", { mode: "timestamp_ms" }),
		/** 3つ(lat/lng/radius)揃うか全てnull */
		geoCenterLat: real("geo_center_lat"),
		geoCenterLng: real("geo_center_lng"),
		geoRadiusM: integer("geo_radius_m"),
		participantsMin: integer("participants_min").notNull(),
		participantsMax: integer("participants_max").notNull(),
		participantsIncludesOwner: integer("participants_includes_owner", {
			mode: "boolean",
		}).notNull(),
		budgetMin: integer("budget_min"),
		budgetMax: integer("budget_max"),
		currency: text("currency"),
		hardConstraints: text("hard_constraints", { mode: "json" }).notNull(),
		softConstraints: text("soft_constraints", { mode: "json" }).notNull(),
		negativeConstraints: text("negative_constraints", {
			mode: "json",
		}).notNull(),
		/** v1.0はhidden_until_match単値(docs/01 §21) */
		visibility: text("visibility").$type<IntentVisibility>().notNull(),
		notificationLevel: text("notification_level")
			.$type<NotificationLevel>()
			.notNull(),
		/** 機会Intentのみtrueになり得る */
		alcoholInvolved: integer("alcohol_involved", { mode: "boolean" }).notNull(),
		status: text("status").$type<IntentStatus>().notNull(),
		/** 更新ごと+1(docs/01 §16) */
		version: integer("version").notNull(),
		/** つながり=既定30日(7/30/90選択)/機会=既定start+3時間。draft保存ではnull許容 */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		/** 埋め込み済みモデル識別子(docs/01 §18) */
		embeddingModel: text("embedding_model"),
		embeddedAt: integer("embedded_at", { mode: "timestamp_ms" }),
		/** 30分再評価抑制(docs/05 §2.6) */
		lastEvaluatedAt: integer("last_evaluated_at", { mode: "timestamp_ms" }),
		/** ベクトル削除実行記録(2窓走査用・docs/05 §2.6) */
		vectorDeletedAt: integer("vector_deleted_at", { mode: "timestamp_ms" }),
		/** active化後10分の1回きり遅延再評価の実行済み記録(docs/06 §2(h)) */
		delayedReevalAt: integer("delayed_reeval_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		index("intents_user_id_status_idx").on(t.userId, t.status),
		index("intents_status_form_category_idx").on(t.status, t.form, t.category),
		// 機会Bucket走査
		index("intents_status_starts_at_idx").on(t.status, t.startsAt),
		// 期限バッチ
		index("intents_status_expires_at_idx").on(t.status, t.expiresAt),
	],
);

/** マッチングパイプラインへのQueues投入の記録(冪等性) */
export const matchEvents = sqliteTable(
	"match_events",
	{
		id: text("id", { length: 26 }).primaryKey(),
		eventType: text("event_type").$type<MatchEventType>().notNull(),
		sourceIntentId: text("source_intent_id", { length: 26 })
			.notNull()
			.references(() => intents.id),
		version: integer("version").notNull(),
		payload: text("payload", { mode: "json" }).notNull(),
		status: text("status").$type<MatchEventStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		processedAt: integer("processed_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("match_events_event_type_source_intent_id_version_uniq").on(
			t.eventType,
			t.sourceIntentId,
			t.version,
		),
		// 削除APIの子の削除(source_intent_id)と、Cronの未処理・反映待ちの掃査
		// (status・created_at)が全件走査にならないようにする(#16)
		index("match_events_source_intent_id_idx").on(t.sourceIntentId),
		index("match_events_status_created_at_idx").on(t.status, t.createdAt),
	],
);

/** 1対1評価の途中結果(30日定期削除・docs/01 §21) */
export const matchCandidates = sqliteTable(
	"match_candidates",
	{
		id: text("id", { length: 26 }).primaryKey(),
		/** 常に a.id < b.id に正規化 */
		intentAId: text("intent_a_id", { length: 26 })
			.notNull()
			.references(() => intents.id),
		intentBId: text("intent_b_id", { length: 26 })
			.notNull()
			.references(() => intents.id),
		intentAVersion: integer("intent_a_version").notNull(),
		intentBVersion: integer("intent_b_version").notNull(),
		/** 同formのみ(docs/01 §12) */
		form: text("form").$type<IntentForm>().notNull(),
		retrievalScore: real("retrieval_score"),
		cheapJudgeScore: real("cheap_judge_score"),
		/** 7軸の数値のみ(reasonなし・docs/01 §13) */
		jevResult: text("jev_result", { mode: "json" }),
		latchScore: real("latch_score"),
		/** 再提案判定用(機会Intentのみ使用) */
		prevLatchScore: real("prev_latch_score"),
		status: text("status").$type<MatchCandidateStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("match_candidates_intent_pair_versions_uniq").on(
			t.intentAId,
			t.intentBId,
			t.intentAVersion,
			t.intentBVersion,
		),
		index("match_candidates_intent_a_id_idx").on(t.intentAId),
		index("match_candidates_intent_b_id_idx").on(t.intentBId),
	],
);

/**
 * グループ(3人以上・Pool最大15)評価の途中結果(30日定期削除・docs/01 §21)。
 * docs/05 §2.2にid列の記載がないが「IDはすべてULID」(docs/05冒頭)に従いidを持つ。
 */
export const groupCandidates = sqliteTable(
	"group_candidates",
	{
		id: text("id", { length: 26 }).primaryKey(),
		/** 参加Intent(3..4)の配列。UNIQUE(intent_ids正規化文字列, 各version)の素材 */
		intentIds: text("intent_ids", { mode: "json" }).$type<string[]>().notNull(),
		/**
		 * intent_ids正規化文字列: intent_idsをID順ソートし `${id}@${version}` を
		 * カンマ結合した文字列。同ペア集合の再評価を排他するUNIQUE列
		 */
		dedupKey: text("dedup_key").notNull(),
		aggregateScore: real("aggregate_score").notNull(),
		/** 再提案判定用(機会Intentのみ使用) */
		prevAggregateScore: real("prev_aggregate_score"),
		status: text("status").$type<GroupCandidateStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [uniqueIndex("group_candidates_dedup_key_uniq").on(t.dedupKey)],
);

/** 同一ユーザーペアへの再提案恒久排除(docs/01 §8) */
export const proposalHistory = sqliteTable(
	"proposal_history",
	{
		id: text("id", { length: 26 }).primaryKey(),
		/** 常に low < high に正規化 */
		userLow: text("user_low", { length: 26 })
			.notNull()
			.references(() => users.id),
		userHigh: text("user_high", { length: 26 })
			.notNull()
			.references(() => users.id),
		latchId: text("latch_id", { length: 26 }).references(() => latches.id),
		/** 恒久排除はmatched/rejected行の存在のみ。deferred/expiredは機会Intentの条件付き再提案の参照に使う */
		outcome: text("outcome").$type<ProposalOutcome>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		/** 同一ペアの再提案でoutcomeを更新した時刻(見送り後の再提案抑制の起点・docs/01 §8) */
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("proposal_history_user_low_user_high_uniq").on(
			t.userLow,
			t.userHigh,
		),
	],
);

/** LATCH(提案〜成立)本体 */
export const latches = sqliteTable(
	"latches",
	{
		id: text("id", { length: 26 }).primaryKey(),
		form: text("form").$type<IntentForm>().notNull(),
		/** ULID配列(2..4)。参加メンバーはlatch_members副表で管理 */
		intentIds: text("intent_ids", { mode: "json" }).$type<string[]>().notNull(),
		/** 成立後に表示する上位集合(docs/05 §3.3)。成立前の応答は旨・回答期限・必要人数のみ */
		proposal: text("proposal", { mode: "json" }).notNull(),
		/** 内部利用(順序付け・計測)。UIには表示しない(docs/01 §10裁定) */
		score: real("score").notNull(),
		status: text("status").$type<LatchStatus>().notNull(),
		responseDeadline: integer("response_deadline", {
			mode: "timestamp_ms",
		}).notNull(),
		/** 参加Intent期限の最小値 */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		/** 非正規化。メッセージ書き込み時に更新(90日判定の索引・docs/05 §2.6) */
		lastMessageAt: integer("last_message_at", {
			mode: "timestamp_ms",
		}).notNull(),
		/** 機会=対象時刻経過 / つながり=最終メッセージから90日経過 */
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		/** 保留中(candidate)から提案中(proposed)へ進めた時刻。pending残留の掃査・提示基準(docs/06 §4) */
		proposedAt: integer("proposed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		// 回答期限切れ走査(docs/06 §4)
		index("latches_status_response_deadline_idx").on(
			t.status,
			t.responseDeadline,
		),
		// 保留中(candidate)の残留掃査(docs/06 §4)
		index("latches_status_proposed_at_idx").on(t.status, t.proposedAt),
		// つながり90日completed判定の走査(docs/05 §2.6)
		index("latches_status_form_last_message_at_idx").on(
			t.status,
			t.form,
			t.lastMessageAt,
		),
	],
);

/** latchesの参加者副表。「自分の提案・成立」の一覧取得はこの表経由(docs/05 §2.4) */
export const latchMembers = sqliteTable(
	"latch_members",
	{
		latchId: text("latch_id", { length: 26 }).notNull(),
		userId: text("user_id", { length: 26 }).notNull(),
		// 離脱時刻。nullは参加中(F4b設計・docs/05 §2.2)
		leftAt: integer("left_at", { mode: "timestamp_ms" }),
		// 本人がLATCHを自分の側から消した時刻。nullは非表示にしていない(F6a設計)
		hiddenAt: integer("hidden_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		primaryKey({ columns: [t.latchId, t.userId] }),
		index("latch_members_user_id_latch_id_idx").on(t.userId, t.latchId),
	],
);

/** 提案への回答。yes=参加 / no=明示の拒否(API専用) / defer=見送り */
export const latchResponses = sqliteTable(
	"latch_responses",
	{
		id: text("id", { length: 26 }).primaryKey(),
		latchId: text("latch_id", { length: 26 }).notNull(),
		userId: text("user_id", { length: 26 }).notNull(),
		response: text("response").$type<LatchResponseValue>().notNull(),
		deferReason: text("defer_reason", { mode: "json" }),
		respondedAt: integer("responded_at", { mode: "timestamp_ms" }).notNull(),
		retractedAt: integer("retracted_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("latch_responses_latch_id_user_id_uniq").on(
			t.latchId,
			t.userId,
		),
	],
);

/** LATCH状態遷移の観測点(MLR集計用) */
export const latchStatusEvents = sqliteTable(
	"latch_status_events",
	{
		id: text("id", { length: 26 }).primaryKey(),
		latchId: text("latch_id", { length: 26 }).notNull(),
		/** 生成時の最初の遷移はnull */
		fromStatus: text("from_status").$type<LatchStatus>(),
		toStatus: text("to_status").$type<LatchStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("latch_status_events_latch_id_idx").on(t.latchId)],
);

/** チャットメッセージの正。Durable Objectsは配信のみ(docs/04 §4) */
export const messages = sqliteTable(
	"messages",
	{
		id: text("id", { length: 26 }).primaryKey(),
		latchId: text("latch_id", { length: 26 })
			.notNull()
			.references(() => latches.id),
		userId: text("user_id", { length: 26 })
			.notNull()
			.references(() => users.id),
		body: text("body").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		// 送信側が付ける再送の重複防止ID。nullは付けない送信(F6a設計)
		clientId: text("client_id", { length: 64 }),
	},
	(t) => [
		index("messages_latch_id_id_idx").on(t.latchId, t.id),
		uniqueIndex("messages_latch_id_user_id_client_id_uq").on(
			t.latchId,
			t.userId,
			t.clientId,
		),
	],
);

/** 既読管理(未読表示・つながり品質の開始判定に使用) */
export const chatReads = sqliteTable(
	"chat_reads",
	{
		latchId: text("latch_id", { length: 26 }).notNull(),
		userId: text("user_id", { length: 26 }).notNull(),
		lastReadMessageId: text("last_read_message_id", { length: 26 }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.latchId, t.userId] })],
);

/** 正解データ申告(docs/01 §14・集計はdocs/02 #35の対象) */
export const latchFeedback = sqliteTable(
	"latch_feedback",
	{
		id: text("id", { length: 26 }).primaryKey(),
		latchId: text("latch_id", { length: 26 }).notNull(),
		userId: text("user_id", { length: 26 }).notNull(),
		kind: text("kind").$type<LatchFeedbackKind>().notNull(),
		value: text("value", { mode: "json" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("latch_feedback_latch_id_user_id_kind_uniq").on(
			t.latchId,
			t.userId,
			t.kind,
		),
	],
);

/** ブロック。安全のための証跡として残す(docs/05 §2.5) */
export const blocks = sqliteTable(
	"blocks",
	{
		blockerUserId: text("blocker_user_id", { length: 26 }).notNull(),
		blockedUserId: text("blocked_user_id", { length: 26 }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] })],
);

/** 通報。targetは通報の対象、message_idはtarget=messageのときの対象メッセージ(F7a設計 §3.2) */
export const reports = sqliteTable(
	"reports",
	{
		id: text("id", { length: 26 }).primaryKey(),
		reporter: text("reporter", { length: 26 }).notNull(),
		reportee: text("reportee", { length: 26 }).notNull(),
		reason: text("reason").$type<ReportReason>().notNull(),
		target: text("target").$type<ReportTarget>().notNull(),
		latchId: text("latch_id", { length: 26 }),
		messageId: text("message_id", { length: 26 }),
		note: text("note").notNull(),
		status: text("status").$type<ReportStatus>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		index("reports_reporter_latch_id_reportee_target_status_idx").on(
			t.reporter,
			t.latchId,
			t.reportee,
			t.target,
			t.status,
		),
	],
);

/** アプリ内通知。closedは不成立(rejected/expired/cancelled)の総称(docs/01 §21) */
export const notifications = sqliteTable(
	"notifications",
	{
		id: text("id", { length: 26 }).primaryKey(),
		userId: text("user_id", { length: 26 }).notNull(),
		type: text("type").$type<NotificationType>().notNull(),
		latchId: text("latch_id", { length: 26 }),
		readAt: integer("read_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		// 以下3列はマイグレーション0007で末尾へ追加(INSERT … SELECTの列順に影響する・F7b設計 §2)
		/** intent_expired通知の対象Intent。他の種別はnull */
		intentId: text("intent_id", { length: 26 }),
		/** Web Pushの送出状態。proposal・matchedは作成時pending、他はnone */
		pushState: text("push_state").$type<PushState>().notNull().default("none"),
		pushAttemptedAt: integer("push_attempted_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		index("notifications_user_id_read_at_id_idx").on(t.userId, t.readAt, t.id),
		// 1ユーザー1日6件の上限判定(docs/01 §20)
		index("notifications_user_id_type_created_at_idx").on(
			t.userId,
			t.type,
			t.createdAt,
		),
		uniqueIndex("notifications_latch_id_user_id_type_uniq").on(
			t.latchId,
			t.userId,
			t.type,
		),
		// intent_expiredをIntentごとに1回だけ作る(intent_idがnullの行は重複扱いにならない)
		uniqueIndex("notifications_intent_id_type_uniq").on(t.intentId, t.type),
		// Cronによるpending回収の走査(F7b設計 §5)
		index("notifications_push_state_created_at_idx").on(
			t.pushState,
			t.createdAt,
		),
	],
);

/** Web Push購読 */
export const pushSubscriptions = sqliteTable(
	"push_subscriptions",
	{
		id: text("id", { length: 26 }).primaryKey(),
		userId: text("user_id", { length: 26 }).notNull(),
		endpoint: text("endpoint").notNull(),
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		status: text("status").$type<PushSubscriptionStatus>().notNull(),
		lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [uniqueIndex("push_subscriptions_endpoint_uniq").on(t.endpoint)],
);

/** セッション開始計測(DAU・再来訪) */
export const sessions = sqliteTable("sessions", {
	id: text("id", { length: 26 }).primaryKey(),
	userId: text("user_id", { length: 26 }).notNull(),
	startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
});

/** 体感アンケート(docs/01 §7・完成条件外) */
export const surveyResponses = sqliteTable(
	"survey_responses",
	{
		id: text("id", { length: 26 }).primaryKey(),
		userId: text("user_id", { length: 26 }).notNull(),
		kind: text("kind").$type<SurveyKind>().notNull(),
		answers: text("answers", { mode: "json" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("survey_responses_user_id_kind_uniq").on(t.userId, t.kind),
	],
);

/** 正解データ(docs/01 §14)。退会後はlatch_idをnull化しanonymized=true(docs/05 §2.5) */
export const calibrationRecords = sqliteTable("calibration_records", {
	id: text("id", { length: 26 }).primaryKey(),
	latchId: text("latch_id", { length: 26 }).references(() => latches.id),
	form: text("form").$type<IntentForm>().notNull(),
	/** latch_score・jev 7軸 */
	prediction: text("prediction", { mode: "json" }).notNull(),
	outcome: text("outcome").$type<CalibrationOutcome>().notNull(),
	/** 機会={attended} / つながり={chat_started_7d, exchanges_7d, exchanges_30d, blocked} */
	action: text("action", { mode: "json" }).notNull(),
	/** つながり7日時点の1問 */
	survey: text("survey", { mode: "json" }),
	anonymized: integer("anonymized", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * レート制限・Jev予算の3層保護の実体(docs/05 §2.2)。
 * 加算は UPDATE … SET count=count+1 … RETURNING の原子的1文で行う。
 */
export const usageCounters = sqliteTable(
	"usage_counters",
	{
		scope: text("scope").$type<CounterScope>().notNull(),
		/** user_id | intent_id | '-' */
		key: text("key").notNull(),
		/** 日付or時間のバケット文字列 */
		period: text("period").notNull(),
		count: integer("count").notNull(),
	},
	(t) => [primaryKey({ columns: [t.scope, t.key, t.period] })],
);

/** 地名の代表点(逆引き・丸め用。D-A-03) */
export const geofeatures = sqliteTable(
	"geofeatures",
	{
		id: text("id", { length: 26 }).primaryKey(),
		name: text("name").notNull(),
		municipality: text("municipality").notNull(),
		type: text("type").$type<GeofeatureType>().notNull(),
		lat: real("lat").notNull(),
		lng: real("lng").notNull(),
		/** 約1km=0.01度グリッドのキー */
		gridKey: text("grid_key").notNull(),
	},
	(t) => [index("geofeatures_grid_key_idx").on(t.gridKey)],
);

/**
 * 直近のベクトルの控え(#47・設計 2026-10-25 §1.2)。Layer 2 Candidate Retrievalの照会が
 * 古い状態を返したときに、埋め込みから15分以内の意思を補うためにD1にも控える。
 * 1つの意思に1行(新しい埋め込みで上書き)。formとstatusは持たず、評価の照会でintentsと結合して絞る。
 * 意思の削除で一緒に消える(ON DELETE CASCADE)。15分を過ぎた行は毎分Cronの保持期間の処理で消す
 */
export const recentVectors = sqliteTable(
	"recent_vectors",
	{
		intentId: text("intent_id", { length: 26 })
			.primaryKey()
			.references(() => intents.id, { onDelete: "cascade" }),
		/** 埋め込みの時刻(intents.embedded_atと同じ値) */
		embeddedAt: integer("embedded_at", { mode: "timestamp_ms" }).notNull(),
		/** 埋め込みのベクトル(float32の並び・bge-m3は1,024次元で約4KB) */
		vector: blob("vector", { mode: "buffer" }).notNull(),
	},
	(t) => [index("recent_vectors_embedded_at_idx").on(t.embeddedAt)],
);
