/**
 * Web Pushの本文暗号化(RFC 8291 aes128gcm・F7b設計 §5.3)。
 * 本文は1レコード固定(RFC 8291 §4)。WebCryptoのECDH・HKDF・AES-GCMだけを使う。
 */

const enc = new TextEncoder();

/** RFC 8291 §4: rs はレコード全体より大きくする。ヘッダの rs は4096固定 */
const RECORD_SIZE = 4096;

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
};

async function hkdf(
	salt: Uint8Array,
	ikm: Uint8Array,
	info: Uint8Array,
	bytes: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

/**
 * RFC 8291 §3.3〜§3.4 の鍵導出で平文を暗号化し、ヘッダ付きの本文を返す。
 * inject はRFC試験ベクトル用(無ければsaltと送信者の鍵対を毎回生成する)。
 */
export async function encryptAes128gcm(
	plaintext: Uint8Array,
	uaPublicKey: Uint8Array,
	authSecret: Uint8Array,
	inject?: { salt: Uint8Array; asKeyPair: CryptoKeyPair },
): Promise<Uint8Array> {
	const salt = inject?.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const asKeyPair =
		inject?.asKeyPair ??
		((await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"],
		)) as CryptoKeyPair);
	const asPublic = new Uint8Array(
		(await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer,
	);
	const uaKey = await crypto.subtle.importKey(
		"raw",
		uaPublicKey,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			// 実行環境は標準の public を要求する(型定義だけが $public を持つ)
			{
				name: "ECDH",
				public: uaKey,
			} as unknown as SubtleCryptoDeriveKeyAlgorithm,
			asKeyPair.privateKey,
			256,
		),
	);
	// RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0"||ua||as, 32)
	const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicKey, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
	// RFC 8188 §2.2〜§2.3: CEK(16)とNONCE(12)
	const cek = await hkdf(
		salt,
		ikm,
		enc.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdf(
		salt,
		ikm,
		enc.encode("Content-Encoding: nonce\0"),
		12,
	);
	// 区切り0x02を末尾に足した1レコード(RFC 8291 §4)
	const record = concat(plaintext, new Uint8Array([0x02]));
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
		"encrypt",
	]);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
	);
	const header = new Uint8Array(21);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	return concat(header, asPublic, cipher);
}
