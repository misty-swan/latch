/**
 * Embeddingのstub(docs/07 §2(c))。正規化テキスト由来のSHA-256ハッシュから
 * 決定的な擬似ベクトル(1024次元・L2正規化)を生成する。Workers AIは呼ばない。
 * 標準WebCrypto(crypto.subtle)のみを使用し、workerd・テスト双方で動く。
 */

/** 出力次元。Workers AI @cf/baai/bge-m3 と同一(07 §1・§4) */
export const EMBEDDING_DIMENSIONS = 1024;

const MASK64 = (1n << 64n) - 1n;

/** xorshift64*の乗数(Vignaの定数) */
const XORSHIFT64_STAR_MULTIPLIER = 0x2545f4914f6cdd1dn;

/** 全ゼロ状態はxorshiftで動かないため、種が0なら固定値へ置き換える */
const ZERO_SEED_FALLBACK = 0x9e3779b97f4a7c15n;

/**
 * SHA-256ダイジェストの先頭8バイト(big-endian u64)をPRNGの種にする(07 §2(c))。
 */
const seedFromDigest = (digest: ArrayBuffer): bigint => {
	const seed = new DataView(digest).getBigUint64(0);
	return seed === 0n ? ZERO_SEED_FALLBACK : seed;
};

/**
 * xorshift64*(07 §2(c))。モジュール状態を持たせないため、状態は呼び出し側で保持する。
 */
const nextRandom64 = (state: { value: bigint }): bigint => {
	let x = state.value;
	x ^= x >> 12n;
	x ^= (x << 25n) & MASK64;
	x ^= x >> 27n;
	state.value = x;
	return (x * XORSHIFT64_STAR_MULTIPLIER) & MASK64;
};

/** 入力文字列から決定的な1024次元ベクトルを返す(07 §2(c)) */
export const stubEmbedding = async (input: string): Promise<number[]> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	const state = { value: seedFromDigest(digest) };

	// 64bit出力の上位53bitを[0,1)へ写像し、さらに[-1,1)へ広げる
	const values: number[] = [];
	for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
		const unit = Number(nextRandom64(state) >> 11n) / 2 ** 53;
		values.push(unit * 2 - 1);
	}

	// L2正規化(ノルム1へ揃える・07 §2(c))
	let sumOfSquares = 0;
	for (const value of values) {
		sumOfSquares += value * value;
	}
	const norm = Math.sqrt(sumOfSquares);
	return values.map((value) => value / norm);
};
