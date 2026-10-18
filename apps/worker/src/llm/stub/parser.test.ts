import { describe, expect, it } from "vitest";
import { fixedClock } from "../../clock/clock";
import { stubParse } from "./parser";

// 全ケース共通の基準時刻(JST 2026-10-17 09:00)。翌日は2026-10-18
const fixed = fixedClock(new Date("2026-10-17T00:00:00Z"));

describe("stubParseのform判定(07 §3: 時制語の有無・既定は安全側のconnection)", () => {
	it("時制語のない文章はつながりIntent・時刻null・既定人数{2,2}", () => {
		const out = stubParse("個人開発仲間が欲しい", fixed);
		expect(out.form).toBe("connection");
		expect(out.time).toBeNull();
		expect(out.participants).toEqual({ min: 2, max: 2 });
		expect(out.budget).toBeNull();
		expect(out.alcohol_involved).toBe(false);
	});

	it("時刻語(日曜17時)は機会Intentで基準日のJST翌日のstartを持つ", () => {
		const out = stubParse("日曜17時にカレー会", fixed);
		expect(out.form).toBe("occasion");
		expect(out.time).toEqual({ start: "2026-10-18T17:00:00+09:00", end: null });
	});

	it("日付語のみ(時刻なし)は機会Intent・時刻null", () => {
		const out = stubParse("明日ランチしよう", fixed);
		expect(out.form).toBe("occasion");
		expect(out.time).toBeNull();
	});

	it("時刻語の「半」は30分として解釈する", () => {
		const out = stubParse("19時半に集まろう", fixed);
		expect(out.form).toBe("occasion");
		expect(out.time?.start).toBe("2026-10-18T19:30:00+09:00");
	});
});

describe("stubParseの抽出規則(07 §3: 金額・人数)", () => {
	it("「5000円くらい」は確定値5000に丸めてmin=max", () => {
		const out = stubParse("5000円くらいでランチ", fixed);
		expect(out.budget).toEqual({ min: 5000, max: 5000 });
		expect(out.form).toBe("connection");
	});

	it("「2〜4人」はmin=2/max=4", () => {
		const out = stubParse("2〜4人でボードゲーム", fixed);
		expect(out.participants).toEqual({ min: 2, max: 4 });
	});

	it("単独の「3人で」はmin=max=3", () => {
		const out = stubParse("3人でカフェ", fixed);
		expect(out.participants).toEqual({ min: 3, max: 3 });
	});
});

describe("stubParseの飲酒判定(07 §3の辞書・部分一致)", () => {
	it("「銀座でワイン会」は飲酒あり", () => {
		expect(stubParse("銀座でワイン会", fixed).alcohol_involved).toBe(true);
	});

	it("「コーヒー好き集まれ」は飲酒なし", () => {
		expect(stubParse("コーヒー好き集まれ", fixed).alcohol_involved).toBe(false);
	});

	it("「飲み会」は飲酒あり", () => {
		expect(stubParse("渋谷で飲み会", fixed).alcohol_involved).toBe(true);
	});
});

describe("stubParseのtopicと固定フィールド(07 §3・04 §5の上限)", () => {
	it("topicは最初の句点まで", () => {
		expect(
			stubParse("カレー会をします。的心理テストもします", fixed).topic,
		).toBe("カレー会をします");
	});

	it("topicは最初の改行まで", () => {
		expect(stubParse("ボードゲーム会\n詳しくはDMで", fixed).topic).toBe(
			"ボードゲーム会",
		);
	});

	it("topicは40字で切り詰める", () => {
		const out = stubParse("あ".repeat(50), fixed);
		expect(out.topic).toHaveLength(40);
	});

	it("categoryとwarningsはstubでは固定値", () => {
		const out = stubParse("カレー会", fixed);
		expect(out.category).toBeNull();
		expect(out.warnings).toEqual([]);
	});
});

describe("stubParseの期限選択肢(05 §2.2: つながり=7/30/90日・機会=start+3時間)", () => {
	it("時刻語あり(機会)はstart+3時間の1件・JSTオフセット付きISO", () => {
		const out = stubParse("日曜17時にカレー会", fixed);
		expect(out.expires_at_options).toEqual(["2026-10-18T20:00:00+09:00"]);
	});

	it("start+3時間が翌日へまたがる時刻でも暦通りに計算する", () => {
		const out = stubParse("22時半の飲み会", fixed);
		expect(out.time?.start).toBe("2026-10-18T22:30:00+09:00");
		expect(out.expires_at_options).toEqual(["2026-10-19T01:30:00+09:00"]);
	});

	it("日付語のみ(機会・時刻null)はstartが決まらないため空配列", () => {
		const out = stubParse("明日ランチしよう", fixed);
		expect(out.expires_at_options).toEqual([]);
	});

	it("時刻語なし(つながり)はnow+7/30/90日の3件・ISO昇順", () => {
		const out = stubParse("個人開発仲間が欲しい", fixed);
		expect(out.expires_at_options).toEqual([
			"2026-10-24T09:00:00+09:00",
			"2026-11-16T09:00:00+09:00",
			"2027-01-15T09:00:00+09:00",
		]);
	});

	it("同一(input, clock)で2回呼んでも期限選択肢は同一(07 §2の決定性)", () => {
		const input = "個人開発仲間が欲しい";
		const first = stubParse(input, fixed);
		const second = stubParse(input, fixed);
		expect(second.expires_at_options).toEqual(first.expires_at_options);
	});
});

describe("stubParseの範囲外入力の丸め(07 §3: 時刻語は0〜23時のみ・人数は2〜4人へ丸め)", () => {
	it("「25時に渋谷で飲み会」は時刻語を採用せず日付語も無いためつながり・期限選択肢3件", () => {
		const out = stubParse("25時に渋谷で飲み会", fixed);
		// 範囲外の時刻語は不採用=日付語の有無でform判定(この文は日付語なし→つながり)
		expect(out.form).toBe("connection");
		expect(out.time).toBeNull();
		expect(out.participants).toEqual({ min: 2, max: 2 });
		expect(out.warnings).toEqual([]);
		// つながりの既定経路のため期限選択肢はnow+7/30/90日の3件
		expect(out.expires_at_options).toHaveLength(3);
		expect(out.alcohol_involved).toBe(true);
	});

	it("時刻語の採用境界は0〜23時(23時は採用・24時は不採用)", () => {
		expect(stubParse("23時に集合", fixed).time?.start).toBe(
			"2026-10-18T23:00:00+09:00",
		);
		expect(stubParse("24時に集合", fixed).time).toBeNull();
	});

	it("「5人でテニス」は人数を4人へ丸め・warningsにparticipantsの注意表示1件", () => {
		const out = stubParse("5人でテニス", fixed);
		expect(out.participants).toEqual({ min: 4, max: 4 });
		expect(out.warnings).toEqual([
			{
				field: "participants",
				note: "人数は2〜4人の範囲で設定してください",
			},
		]);
	});

	it("「3人〜9人でバレー」は幅の上限を4人へ丸め・warnings1件", () => {
		const out = stubParse("3人〜9人でバレー", fixed);
		expect(out.participants).toEqual({ min: 3, max: 4 });
		expect(out.warnings).toEqual([
			{
				field: "participants",
				note: "人数は2〜4人の範囲で設定してください",
			},
		]);
	});

	it("「1人で」は下限2人へ丸め・warnings1件", () => {
		const out = stubParse("1人で読書", fixed);
		expect(out.participants).toEqual({ min: 2, max: 2 });
		expect(out.warnings).toHaveLength(1);
	});

	it("丸めが効く入力でも同一(input, clock)で同一出力(07 §2の決定性)", () => {
		const input = "25時に渋谷で飲み会 5人で";
		expect(stubParse(input, fixed)).toEqual(stubParse(input, fixed));
	});
});

describe("stubParseの決定性(07 §2: stubは同一入力→同一出力)", () => {
	it("同一(input, clock)で2回呼ぶとdeep equal", () => {
		const input = "日曜17時に銀座でワイン会 5000円くらい 2〜4人";
		const first = stubParse(input, fixed);
		const second = stubParse(input, fixed);
		expect(second).toEqual(first);
		// 併せて全規則が同時に効くことも確認する
		expect(first.form).toBe("occasion");
		expect(first.time?.start).toBe("2026-10-18T17:00:00+09:00");
		expect(first.participants).toEqual({ min: 2, max: 4 });
		expect(first.budget).toEqual({ min: 5000, max: 5000 });
		expect(first.alcohol_involved).toBe(true);
	});
});
