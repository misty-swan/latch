/**
 * sniffImage(magic bytes判定)の単体試験。
 * docs/08 §11: 形式(PNG/JPEG/WebP)をWorkerで検証してから保存。
 * クライアントのContent-Type申告は信頼せず、先頭バイトの署名のみで判定する。
 */

import { describe, expect, it } from "vitest";
import { sniffImage } from "./validate";

/** PNG署名: 89 50 4E 47 0D 0A 1A 0A */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** ASCII文字列をバイト列にする */
const ascii = (text: string): Uint8Array =>
	Uint8Array.from(text, (ch) => ch.charCodeAt(0));

describe("sniffImage(docs/08 §11: magic bytes判定)", () => {
	it("PNG署名(8バイト)はimage/png", () => {
		expect(sniffImage(Uint8Array.from(PNG_SIGNATURE))).toBe("image/png");
	});

	it("PNG署名+後続データがあってもimage/png(実画像の先頭)", () => {
		const bytes = new Uint8Array(70);
		bytes.set(PNG_SIGNATURE);
		expect(sniffImage(bytes)).toBe("image/png");
	});

	it("JPEG署名(FF D8 FF)はimage/jpeg", () => {
		expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
			"image/jpeg",
		);
		expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
	});

	it("WebP(RIFF+8バイト目からWEBP)はimage/webp", () => {
		// RIFFコンテナ: 「RIFF」+ サイズ4バイト + 「WEBP」
		const bytes = new Uint8Array(12);
		bytes.set(ascii("RIFF"), 0);
		bytes.set(ascii("WEBP"), 8);
		expect(sniffImage(bytes)).toBe("image/webp");
	});

	it("テキスト(hello)はnull", () => {
		expect(sniffImage(new TextEncoder().encode("hello"))).toBeNull();
	});

	it("空バイト列はnull", () => {
		expect(sniffImage(new Uint8Array(0))).toBeNull();
	});

	it("PNG署名の先頭のみ(4バイト)はnull", () => {
		expect(sniffImage(Uint8Array.from(PNG_SIGNATURE.slice(0, 4)))).toBeNull();
	});

	it("RIFFだが8バイト目以降がWEBPでない(riffのみ)はnull", () => {
		const bytes = new Uint8Array(12);
		bytes.set(ascii("RIFF"), 0);
		bytes.set(ascii("WAVE"), 8);
		expect(sniffImage(bytes)).toBeNull();
	});
});
