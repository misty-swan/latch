/**
 * yesの組とnoの組の類似度の「分かれ方」の指標(地域名の比較・設計書 §7)。
 */

/** 中央値(空はNaN) */
export const median = (xs: number[]): number => {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1
		? (s[m] as number)
		: ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** コサイン類似度 */
export const cosine = (a: number[], b: number[]): number => {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/**
 * medianGap=yesの中央値−noの中央値。
 * auc=yesの類似度がnoの類似度より高い確率(同値は0.5)。片方が空ならNaN。
 */
export const separation = (
	yesSims: number[],
	noSims: number[],
): { medianGap: number; auc: number } => {
	if (yesSims.length === 0 || noSims.length === 0) {
		return { medianGap: Number.NaN, auc: Number.NaN };
	}
	let wins = 0;
	for (const y of yesSims) {
		for (const n of noSims) {
			if (y > n) wins += 1;
			else if (y === n) wins += 0.5;
		}
	}
	return {
		medianGap: median(yesSims) - median(noSims),
		auc: wins / (yesSims.length * noSims.length),
	};
};
