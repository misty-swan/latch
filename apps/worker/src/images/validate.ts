/**
 * アイコン画像のmagic bytes判定(docs/08 §11・docs/05 §2.3)。
 * アップロード時のContent-Type等のクライアント申告は信頼せず、先頭バイトの
 * 署名(magic bytes)のみで形式を判定する。docs/08 §11: 形式(PNG/JPEG/WebP)と
 * サイズ(1MB)をWorkerで検証してから保存し、コンテンツ種別を固定して配信する。
 */

/** 判定できた画像のMIME型。R2保存時のhttpMetadata.contentTypeにそのまま使う */
export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/**
 * バイト列の先頭署名から画像形式を判定する(docs/08 §11)。
 * - PNG: 89 50 4E 47 0D 0A 1A 0A(8バイト)
 * - JPEG: FF D8 FF(3バイト)
 * - WebP: RIFF(0..3バイト目)+ WEBP(8..11バイト目)= 12バイト必要
 * いずれにも一致しない場合(必要バイト数に満たない場合を含む)はnull
 */
export const sniffImage = (bytes: Uint8Array): ImageType | null => {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && // R
		bytes[1] === 0x49 && // I
		bytes[2] === 0x46 && // F
		bytes[3] === 0x46 && // F
		bytes[8] === 0x57 && // W
		bytes[9] === 0x45 && // E
		bytes[10] === 0x42 && // B
		bytes[11] === 0x50 // P
	) {
		return "image/webp";
	}
	return null;
};
