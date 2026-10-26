/**
 * ゴールドセットの意思(IntentFixture)を、正規化の関数(buildNormalizedText)が受け取る
 * intents行の形へ写す。正規化に使わない列は固定のダミー値で埋める(採点と地域名の比較で共用)。
 */
import type { intents } from "../../../apps/worker/src/db/schema";
import type { IntentFixture } from "./goldset";

export type IntentRow = typeof intents.$inferSelect;

/** 正規化に関わらない時刻列のダミー値(固定) */
const DUMMY_TIME = new Date("2026-01-01T00:00:00Z");

export const fixtureToRow = (f: IntentFixture): IntentRow => ({
	id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
	userId: "01JYYYYYYYYYYYYYYYYYYYYYYY",
	form: f.form,
	topic: f.topic,
	category: null,
	rawText: "",
	startsAt: f.startsAt,
	endsAt: f.endsAt,
	geoCenterLat: null,
	geoCenterLng: null,
	geoRadiusM: null,
	participantsMin: f.participantsMin,
	participantsMax: f.participantsMax,
	participantsIncludesOwner: f.participantsIncludesOwner,
	budgetMin: f.budgetMin,
	budgetMax: f.budgetMax,
	currency: f.budgetMin !== null || f.budgetMax !== null ? "JPY" : null,
	hardConstraints: [],
	softConstraints: f.softConstraints,
	negativeConstraints: f.negativeConstraints,
	visibility: "hidden_until_match",
	notificationLevel: "proposals_only",
	alcoholInvolved: false,
	status: "active",
	version: 1,
	expiresAt: null,
	embeddingModel: null,
	embeddedAt: null,
	lastEvaluatedAt: null,
	vectorDeletedAt: null,
	delayedReevalAt: null,
	jevHeldAt: null,
	jevHeldReason: null,
	jevHeldCount: 0,
	createdAt: DUMMY_TIME,
	updatedAt: DUMMY_TIME,
});
