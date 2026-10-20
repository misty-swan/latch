/**
 * コサイン類似度(内積/ノルム積・docs/05 §2.3の距離=cosine)。
 * どちらかのノルムが0・長さ不一致のときは0に倒す(NaNを返さない)。
 * インメモリVectorStoreとグループ集合のPool選定が共有する
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
	if (a.length !== b.length) {
		return 0;
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
};
