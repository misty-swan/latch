/**
 * real接続の指示文とモデル名(設計書§0.4・§3.2・§4.1・§5)。
 * 指示文はコード内の定数として版を持つ(D-D-01の暫定案)。採点の記録は本ファイルの
 * 指示文・出力スキーマ・モデル名の指紋(SHA-256)を持ち、CIが照合する(設計書§3.2)。
 * ここを変えたら採点をやり直す。
 */
import {
	CATEGORIES,
	LIMITS,
	PARTICIPANTS_MAX,
	PARTICIPANTS_MIN,
} from "@latch/shared";
import { JEV_AXES, type JevAxis } from "../types";

/** Parserと予備のJevに使うAnthropicのモデル(ID固定・設計書§0.4) */
export const ANTHROPIC_MODEL = "claude-haiku-5-5";

/**
 * Jevの第一候補TypeSafeのモデル。採点に合格した版の名前に固定する(設計書§0.4)。
 * 2026-10-24の採点で応答した版jev-1.14.0に固定した。"jev-latest"のままでは採点の記録を合格にしない(採点の道具で検査する)
 */
export const TYPESAFE_MODEL = "jev-1.14.0";

/**
 * Parserのsystem文(07 §3・設計書§4.1)。入力はraw_textと現在時刻(JST)だけ。
 * nowJstはJSTオフセット付きISO(例: 2026-10-24T09:00:00+09:00)
 */
export const PARSER_SYSTEM_PROMPT = (nowJst: string): string =>
	`あなたは、利用者が日本語で書いた「誰かとしたいこと」の文を、決められたJSONへ読み解く係です。
出力はJSONスキーマに従うJSONだけを返します。説明や前置きは書きません。

現在時刻(日本時間): ${nowJst}

# form(預け方)
- "occasion"(機会): 特定の日時・日付に一度きりで行う予定。日付や時刻の表現(「明日」「今週土曜」「19時」「10月30日」など)があるとき
- "connection"(つながり): 日時を決めず、続く関係や趣味仲間を求めるもの。日付・時刻の表現がないとき
- 迷うときは"connection"にします(利用者が確認画面で必ず確かめて切り替えます)

# topic
- したいことの主題を短い日本語で書きます(${LIMITS.TOPIC_MAX_LENGTH}字以内)。例: 「ボードゲーム」「軽く飲み」
- 集合場所・店・駅・住んでいる地域の名前はtopicに入れません(「渋谷で軽く飲み」ではなく「軽く飲み」)。行き先そのものが目的のとき(登る山・テーマパーク・観光地など)はtopicに残します。場所の言及はwarningsの {"field":"geo"} で知らせます
- 日時・人数・予算は含めません

# category
- 次の一覧から最も近いものを1つ、表記どおりに選びます: ${CATEGORIES.join("、")}
- どれにも当てはまらないときは「その他」にします

# time
- formが"occasion"で時刻まで読み取れるときだけ {"start": ..., "end": null} を返します。それ以外はnull
- startは「YYYY-MM-DDTHH:MM:00+09:00」の形(日本時間のオフセット付き)
- 時は0〜23時だけを時刻として扱います(「25時」などは時刻にしません)。「半」は30分です
- 日付が書かれていない時刻は、現在時刻の翌日のその時刻にします。「今日」「明日」「土曜」などは現在時刻から数えます
- 日付だけで時刻が無いときは、formを"occasion"にしてtimeはnullにします

# participants(自分を含む人数)
- 人数は${PARTICIPANTS_MIN}〜${PARTICIPANTS_MAX}人です。「2〜4人」はmin=2・max=4、「3人」はmin=max=3。書かれていなければmin=max=2
- 範囲の外の人数(「1人」「10人」など)は${PARTICIPANTS_MIN}〜${PARTICIPANTS_MAX}人へ丸め、warningsに {"field":"participants","note":"人数は${PARTICIPANTS_MIN}〜${PARTICIPANTS_MAX}人の範囲で設定してください"} を1件載せます

# budget(円)
- 金額が書かれているときだけ {"min", "max"} を整数の円で返します。それ以外はnull
- 「5000円くらい」「5000円程度」は確定値へ丸めてmin=max=5000。「3000〜5000円」はmin=3000・max=5000

# alcohol_involved
- お酒を飲むことが含まれる、または暗に示されるときtrue。見逃さないことを優先します
- trueの例: 飲み・飲み会・一杯・晩酌・ビール・ワイン会・日本酒・居酒屋・バー(「バーで誕生日会」も含む)・ビアガーデン・はしご酒
- falseの例: コーヒー・カフェ・お茶・ランチ・ジュース

# warnings
- 確認画面で利用者に確かめてほしいことを {"field", "note"} で載せます。noteは短い日本語です
- 場所・地域・駅名・店名の言及があるときは {"field":"geo","note":"場所は地図で設定してください"} を1件載せます(場所はこの読み解きでは決めません)
- 人数を丸めたときは上の participants の注意を載せます
- 当てはまるものが無ければ空の配列`;

/** 時刻の形(time.start)。正しさは組み立て後にzodで検証する */
const ISO_STRING = { type: "string" } as const;

/**
 * Parserの出力スキーマ(05 §3.3のparse応答のうちParserが埋めるフィールド。期限の選択肢は
 * コードで求めるためモデルに求めない・設計書§4)。
 * 構造化出力はminimum/maximum等の数値制約を受け付けないため型と必須だけを書き、
 * 範囲・一覧の外は組み立て後のzod検証でinvalid_outputにする(設計書§4.2)
 */
export const PARSER_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		form: { type: "string", enum: ["connection", "occasion"] },
		topic: { type: "string" },
		category: { type: "string", enum: [...CATEGORIES] },
		time: {
			anyOf: [
				{
					type: "object",
					properties: { start: ISO_STRING, end: { type: "null" } },
					required: ["start", "end"],
					additionalProperties: false,
				},
				{ type: "null" },
			],
		},
		participants: {
			type: "object",
			properties: { min: { type: "integer" }, max: { type: "integer" } },
			required: ["min", "max"],
			additionalProperties: false,
		},
		budget: {
			anyOf: [
				{
					type: "object",
					properties: { min: { type: "integer" }, max: { type: "integer" } },
					required: ["min", "max"],
					additionalProperties: false,
				},
				{ type: "null" },
			],
		},
		alcohol_involved: { type: "boolean" },
		warnings: {
			type: "array",
			items: {
				type: "object",
				properties: { field: { type: "string" }, note: { type: "string" } },
				required: ["field", "note"],
				additionalProperties: false,
			},
		},
	},
	required: [
		"form",
		"topic",
		"category",
		"time",
		"participants",
		"budget",
		"alcohol_involved",
		"warnings",
	],
	additionalProperties: false,
} as const;

/** Jevの1軸の問い(TypeSafeのnoul形式・設計書§5.1)。intent_a・intent_bをバッククォートで指す */
export interface JevQuestion {
	instructions: string;
	criteria: { true: string; false: string };
}

/** Jevの7軸の問い(07 §5・01 §13) */
export const JEV_QUESTIONS: Record<JevAxis, JevQuestion> = {
	would_a_accept_b: {
		instructions:
			"`intent_a`を書いた人は、`intent_b`を書いた人からの誘いを受けて、一緒に参加したいと思うか",
		criteria: {
			true: "`intent_a`の人が`intent_b`の人と一緒に参加することを受け入れる",
			false: "`intent_a`の人は`intent_b`の人と一緒に参加することを断る",
		},
	},
	would_b_accept_a: {
		instructions:
			"`intent_b`を書いた人は、`intent_a`を書いた人からの誘いを受けて、一緒に参加したいと思うか",
		criteria: {
			true: "`intent_b`の人が`intent_a`の人と一緒に参加することを受け入れる",
			false: "`intent_b`の人は`intent_a`の人と一緒に参加することを断る",
		},
	},
	purpose_fit: {
		instructions:
			"`intent_a`と`intent_b`は、したいこと(目的・活動)が一致しているか",
		criteria: {
			true: "両者のしたいことが同じか、一緒にして両方が満たされる",
			false: "したいことが違い、一緒にしても片方しか満たされない",
		},
	},
	mood_fit: {
		instructions:
			"`intent_a`と`intent_b`は、求める雰囲気・温度感(気軽さ・真剣さ・にぎやかさなど)が合っているか",
		criteria: {
			true: "求める雰囲気が近く、一緒にいて違和感がない",
			false: "求める雰囲気が食い違い、どちらかが居心地悪く感じる",
		},
	},
	timing_fit: {
		instructions:
			"`intent_a`と`intent_b`の時機が合っているか。日時の決まった機会なら日時が一致するか、日時の無いつながりなら関係の温度と始めたい時機が一致するか",
		criteria: {
			true: "機会なら日時が重なる。つながりなら関係の深さの望みと始める時機が合う",
			false:
				"機会なら日時が重ならない。つながりなら関係の深さの望みか始める時機が食い違う",
		},
	},
	social_fit: {
		instructions:
			"`intent_a`と`intent_b`は、人数・相手への条件・人付き合いの距離感が両立するか",
		criteria: {
			true: "人数や相手への条件・距離感が両方とも満たされる",
			false: "人数や相手への条件・距離感のどれかが両立しない",
		},
	},
	latent_yes: {
		instructions:
			"`intent_a`と`intent_b`の人に、この組み合わせを提案したら、両者とも実際に参加すると答えるか",
		criteria: {
			true: "両者とも提案に参加すると答える",
			false: "少なくともどちらかが提案を見送る",
		},
	},
};

/**
 * 予備のJev(Anthropic)のsystem文(設計書§5.2)。7軸の確率の数値だけを返させ、
 * 理由文は求めない(07 §5)
 */
export const JEV_ANTHROPIC_SYSTEM_PROMPT = `あなたは、2人の利用者が書いた「誰かとしたいこと」(intent_aとintent_b)を読み、2人を引き合わせたときに成り立つかを確率で判定する係です。
次の${JEV_AXES.length}つの問いそれぞれについて、「はい」である確率を0から1の数値で答えます。
出力はJSONスキーマに従うJSONだけを返します。理由・説明・前置きは書きません。

${JEV_AXES.map(
	(axis) =>
		`- ${axis}: ${JEV_QUESTIONS[axis].instructions}
  はい(1に近い): ${JEV_QUESTIONS[axis].criteria.true}
  いいえ(0に近い): ${JEV_QUESTIONS[axis].criteria.false}`,
).join("\n")}`;

/**
 * 予備のJevの出力スキーマ(7軸の数値のみ・設計書§5.2)。0〜1の範囲は構造化出力が
 * 数値制約を受け付けないため、受け取った後に検証してinvalid_outputにする
 */
export const JEV_OUTPUT_SCHEMA = {
	type: "object",
	properties: Object.fromEntries(
		JEV_AXES.map((axis) => [axis, { type: "number" }]),
	),
	required: [...JEV_AXES],
	additionalProperties: false,
} as const;
