/**
 * buildNormalizedText(正規化テキスト生成)の単体試験。
 * docs/07 §4の構成(topic / constraints / participants / 機会のみ時刻・予算・
 * geo不使用)と決定性を検証する。時刻の規律(docs/04 §4)により
 * 現在時刻へ依存しない純関数である。
 */
import { describe, expect, it } from "vitest";
import type { intents } from "../db/schema";
import { buildNormalizedText } from "./normalize";

/** intents行の完全なフィクスチャ。指定のない欄は最小構成の値で埋める */
const intentRow = (
	overrides: Partial<typeof intents.$inferSelect> = {},
): typeof intents.$inferSelect => ({
	id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
	userId: "01JYYYYYYYYYYYYYYYYYYYYYYY",
	form: null,
	topic: null,
	category: null,
	rawText: "",
	startsAt: null,
	endsAt: null,
	geoCenterLat: null,
	geoCenterLng: null,
	geoRadiusM: null,
	participantsMin: 2,
	participantsMax: 4,
	participantsIncludesOwner: true,
	budgetMin: null,
	budgetMax: null,
	currency: null,
	hardConstraints: [],
	softConstraints: [],
	negativeConstraints: [],
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
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...overrides,
});

describe("buildNormalizedText(07 §4: Embedding/Jev入力の正規化テキスト)", () => {
	it("つながりはtopic・constraints・participantsのみ(時刻・予算・geoを含まない)", () => {
		const row = intentRow({
			form: "connection",
			topic: "ランニング仲間",
			softConstraints: ["初級者歓迎", "朝練習"],
			negativeConstraints: ["競技志向"],
			// つながり行に値が紛れていても時刻・予算・geoは出力しない
			startsAt: new Date("2026-10-18T08:00:00Z"),
			budgetMin: 1000,
			budgetMax: 2000,
			geoCenterLat: 31.59,
			geoCenterLng: 130.55,
			geoRadiusM: 500,
		});
		expect(buildNormalizedText(row)).toBe(
			"ランニング仲間・初級者歓迎・朝練習・競技志向・2〜4人",
		);
	});

	it("機会はJST時刻(M/D HH:mm〜HH:mm)と予算(3000〜5000円)を含む", () => {
		const row = intentRow({
			form: "occasion",
			topic: "天文館で飲み会",
			softConstraints: ["駅近"],
			negativeConstraints: ["カラオケ"],
			startsAt: new Date("2026-10-18T08:00:00Z"), // JST 17:00
			endsAt: new Date("2026-10-18T10:00:00Z"), // JST 19:00
			budgetMin: 3000,
			budgetMax: 5000,
		});
		expect(buildNormalizedText(row)).toBe(
			"天文館で飲み会・駅近・カラオケ・2〜4人・10/18 17:00〜19:00・3000〜5000円",
		);
	});

	it("機会でends_atが無い場合は開始時刻のみを含む", () => {
		const row = intentRow({
			form: "occasion",
			topic: "朝カフェ",
			startsAt: new Date("2026-10-18T08:00:00Z"),
			endsAt: null,
			budgetMin: 3000,
			budgetMax: 5000,
		});
		expect(buildNormalizedText(row)).toBe(
			"朝カフェ・2〜4人・10/18 17:00・3000〜5000円",
		);
	});

	it("機会の時刻はUTC+9h固定オフセットで日付が変わってもJST壁時刻で表記する", () => {
		const row = intentRow({
			form: "occasion",
			topic: "深夜の勉強会",
			startsAt: new Date("2026-10-18T15:30:00Z"), // JST 2026-10-19 00:30
		});
		expect(buildNormalizedText(row)).toContain("10/19 00:30");
	});

	it("includes_owner=falseのparticipantsは「募集」を冠する", () => {
		const row = intentRow({ participantsIncludesOwner: false });
		expect(buildNormalizedText(row)).toBe("募集2〜4人");
	});

	it("draftのnull混在行(form・topic・時刻・予算なし)でもparticipantsのみの文字列を返す", () => {
		const row = intentRow({
			form: null,
			topic: null,
			participantsIncludesOwner: false,
		});
		expect(buildNormalizedText(row)).toBe("募集2〜4人");
	});

	it("topicのみの最小構成はtopic・participantsでconstraintsを含まない", () => {
		const row = intentRow({
			form: "connection",
			topic: "カフェで読書会",
			participantsMin: 2,
			participantsMax: 2,
		});
		expect(buildNormalizedText(row)).toBe("カフェで読書会・2〜2人");
	});

	it("同一行からは常に同一文字列を返す(決定性)", () => {
		const row = intentRow({
			form: "occasion",
			topic: "天文館で飲み会",
			softConstraints: ["駅近"],
			negativeConstraints: ["カラオケ"],
			startsAt: new Date("2026-10-18T08:00:00Z"),
			endsAt: new Date("2026-10-18T10:00:00Z"),
			budgetMin: 3000,
			budgetMax: 5000,
		});
		const first = buildNormalizedText(row);
		// 同一行の再呼び出し・同一内容の別行オブジェクトの両方で一致する
		expect(buildNormalizedText(row)).toBe(first);
		expect(buildNormalizedText(intentRow({ ...row }))).toBe(first);
	});

	it("機会で予算がdraftの片側のみの混在でも決定的な表記を返す", () => {
		expect(
			buildNormalizedText(intentRow({ form: "occasion", budgetMin: 3000 })),
		).toBe("2〜4人・3000円以上");
		expect(
			buildNormalizedText(intentRow({ form: "occasion", budgetMax: 5000 })),
		).toBe("2〜4人・5000円以下");
	});
});
