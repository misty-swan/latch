/**
 * Embedding/Jevへの入力とする正規化テキストの生成(docs/07 §4)。
 * 構造化データ(intents行)のみから決定的な文字列を作る純関数で、
 * raw_textは含めない。geo(座標・地域名)も含めない(地域名を含めないのはオーナー決定 2026-10-24・
 * realのEmbeddingとゴールドセットで比べて精度が上がらず、含めなければJevの外部送信に乗らないため・docs/07 §4)。
 * 時刻の規律(docs/04 §4)により現在時刻を参照せず、行の時刻値からの
 * 固定オフセット計算のみでJST壁時刻を作る(Intl不使用)。
 */
import type { intents } from "../db/schema";

/** intents行の型(db/schemaの$inferSelect) */
type IntentRow = typeof intents.$inferSelect;

/** JST=UTC+9の固定オフセット。タイムゾーンデータベース・Intlは使わない(docs/04 §4・clock.tsと同じ規律) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Date値を+9hしてUTC部分を読むことでJSTの月日・時分を得る(固定オフセット計算のみ・現在時刻不使用) */
const jstParts = (d: Date) => {
	const shifted = new Date(d.getTime() + JST_OFFSET_MS);
	return {
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
	};
};

/** 「M/D HH:mm」(JST・月日は0埋めしない) */
const jstDateTime = (d: Date): string => {
	const { month, day, hour, minute } = jstParts(d);
	return `${month}/${day} ${pad2(hour)}:${pad2(minute)}`;
};

/** 「HH:mm」(JST) */
const jstTime = (d: Date): string => {
	const { hour, minute } = jstParts(d);
	return `${pad2(hour)}:${pad2(minute)}`;
};

/** 「2〜4人」形式(includes_owner=falseなら「募集2〜4人」) */
const participantsText = (intent: IntentRow): string => {
	const range = `${intent.participantsMin}〜${intent.participantsMax}人`;
	return intent.participantsIncludesOwner ? range : `募集${range}`;
};

/** 「3000〜5000円」形式(min・maxはセットが原則。draftの片側混在は以上/以下で表記する) */
const budgetText = (intent: IntentRow): string | null => {
	const { budgetMin: min, budgetMax: max } = intent;
	if (min !== null && max !== null) {
		return `${min}〜${max}円`;
	}
	if (min !== null) {
		return `${min}円以上`;
	}
	if (max !== null) {
		return `${max}円以下`;
	}
	return null;
};

/** 否定条件の1項目の表記(「タバコ」→「タバコは不可」・docs/07 §4) */
const negativeText = (item: string): string => `${item}は不可`;

/**
 * 正規化テキストを作る(docs/07 §4の構成・区切りは「・」):
 * topic / ソフト条件の項目(そのまま) / 否定条件の項目(「〜は不可」の印を付ける) / participants /
 * 機会のみJST時刻(M/D HH:mm〜HH:mm・ends_at無ければ開始のみ)と予算。
 * hard_constraints・raw_text・geoは含めない。同一行からは常に同一文字列を返す。
 */
export const buildNormalizedText = (intent: IntentRow): string => {
	const parts: string[] = [];

	// 主題(draftでは未確定null・docs/05 §2.2)
	if (intent.topic !== null) {
		parts.push(intent.topic);
	}
	// ソフト条件は項目をそのまま並べる(json列は書き込み時にZod層で文字列配列を保証)
	parts.push(...(intent.softConstraints as string[]));
	// 否定条件は普通の条件と見分けられるよう「〜は不可」の印を付ける(Jevが否定を肯定と取り違えないため・LAT-113)
	parts.push(...(intent.negativeConstraints as string[]).map(negativeText));
	parts.push(participantsText(intent));

	// 時刻・予算は機会Intentのみ。時刻はJST表記でends_at無しは開始のみ
	if (intent.form === "occasion") {
		if (intent.startsAt !== null) {
			parts.push(
				intent.endsAt !== null
					? `${jstDateTime(intent.startsAt)}〜${jstTime(intent.endsAt)}`
					: jstDateTime(intent.startsAt),
			);
		}
		const budget = budgetText(intent);
		if (budget !== null) {
			parts.push(budget);
		}
	}

	return parts.join("・");
};
