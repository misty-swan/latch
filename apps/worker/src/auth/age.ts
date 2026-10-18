/**
 * 年齢計算(docs/05 §3.2: POST /v1/usersの18歳検証)。
 * clock.tsと同じJST固定オフセット(+9時間)の計算で暦日を取り出し、
 * カレンダー比較で満年齢を数える。タイムゾーンデータベース・Intlは使わない
 * (Workersランタイムで一貫させる)。
 * 純粋関数として実装し、現在時刻は呼び出し側が渡す(docs/04 §4の時刻の規律)
 */

/** JST=UTC+9の固定オフセット(clock.tsのJST_OFFSET_MSと同じ値) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 平年判定(グレゴリオ暦のうるう年規則・4で割り切れるが100で割り切れない年と400で割り切れる年) */
const isLeapYear = (year: number): boolean =>
	(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * birthDate('YYYY-MM-DD')の生まれが「nowの時点」で何歳かを返す。
 * 加齢方式の選択: カレンダー比較方式(誕生日の当日に加齢する)を採用する。
 * 日本の年齢計算に関する法律の満年齢は「誕生日の前日が終わった時点」で加齢し、
 * 2/29生まれの平年は2/28に加齢となるが、本実装は暦日同士の比較の簡明さを優先し、
 * 2/29生まれの平年は3/1到達で加齢と読み替える(うるう年の当日は2/29に加齢)。
 * 登録可否はこの値で `ageAtYears(now, birth_date) >= 18` と判定する(docs/05 §3.2)。
 * birth_dateの書式・実在性はリクエスト検証(birthDateSchema・@latch/shared)が担保する
 */
export const ageAtYears = (now: Date, birthDate: string): number => {
	const [birthYear, birthMonth, birthDay] = birthDate
		.split("-")
		.map(Number) as [number, number, number];
	// nowをJSTにずらした値のUTC部分として暦日を取り出す(clock.tsと同じ固定オフセット計算)
	const shifted = new Date(now.getTime() + JST_OFFSET_MS);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	// 2/29生まれの平年は比較基準日を3/1に読み替える(3/1到達で加齢)
	const isFeb29 = birthMonth === 2 && birthDay === 29;
	const refMonth = isFeb29 && !isLeapYear(year) ? 3 : birthMonth;
	const refDay = isFeb29 && !isLeapYear(year) ? 1 : birthDay;
	const hadBirthday = month > refMonth || (month === refMonth && day >= refDay);
	return year - birthYear - (hadBirthday ? 0 : 1);
};
