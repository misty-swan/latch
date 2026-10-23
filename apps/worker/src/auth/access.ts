/**
 * stagingのCloudflare Accessの証明(Cf-Access-Jwt-Assertion)の検証(#11)。
 * stagingはAccessの背後に置くが、Accessを経由しない到達(workers.devの直アクセス等)を
 * 拒むため、Worker側でも証明を検証する。RS256・iss=チームのドメイン・audにACCESS_AUDを含む・
 * 期限内を確かめる。公開鍵は `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` から取得し、
 * isolate内で保持する(未知のkidのときだけ1回取り直す)。
 * 署名検証はjose(idp.tsと同じRS256の検証)を使う。時刻はjoseが現在時刻で判定する
 */

import { importJWK, type JWK, jwtVerify } from "jose";
import type { Env } from "../env";

export type AccessVerifyResult =
	| { ok: true }
	| { ok: false; reason: "missing" | "invalid" | "jwks_unavailable" };

/** Accessが付けるリクエストヘッダー */
const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/** JWKSを取れなかったことを表す内部例外 */
class JwksUnavailableError extends Error {}

/** 公開鍵のキャッシュ(チームのドメインごとにkid→鍵)。isolate内で保持する */
const keyCache = new Map<string, Map<string, CryptoKey | Uint8Array>>();

/** 試験用: 公開鍵のキャッシュを空にする */
export const resetAccessKeyCacheForTest = (): void => {
	keyCache.clear();
};

/** チームのドメインのJWKSを取り直してキャッシュを置き換える */
const refreshKeys = async (
	teamDomain: string,
	fetchFn: typeof fetch,
): Promise<Map<string, CryptoKey | Uint8Array>> => {
	let body: { keys?: Array<JWK & { kid?: string }> };
	try {
		const response = await fetchFn(`${teamDomain}/cdn-cgi/access/certs`);
		if (!response.ok) {
			throw new JwksUnavailableError(`status ${response.status}`);
		}
		body = (await response.json()) as typeof body;
	} catch (error) {
		throw error instanceof JwksUnavailableError
			? error
			: new JwksUnavailableError(String(error));
	}
	const keys = new Map<string, CryptoKey | Uint8Array>();
	for (const jwk of body.keys ?? []) {
		if (typeof jwk.kid !== "string") continue;
		try {
			keys.set(jwk.kid, await importJWK(jwk, "RS256"));
		} catch {
			// 読めない鍵は無視する(該当kidの証明はinvalidになる)
		}
	}
	// 空の鍵集合では既存の鍵を捨てない(一時的な異常で全kidが失効するのを避ける)
	if (keys.size === 0) {
		return keyCache.get(teamDomain) ?? keys;
	}
	keyCache.set(teamDomain, keys);
	return keys;
};

/** stagingのリクエストのAccessの証明を検証する(ヘッダー無し・不正・JWKS取得不能を区別して返す) */
export const verifyAccessRequest = async (
	request: Request,
	env: Env,
	fetchFn: typeof fetch = fetch,
): Promise<AccessVerifyResult> => {
	const token = request.headers.get(ACCESS_HEADER);
	if (token === null || token === "") {
		return { ok: false, reason: "missing" };
	}
	const audience = env.ACCESS_AUD;
	// 入力ミス(前後の空白・末尾のスラッシュ)を正規化し、JWKSのURLとissの両方に使う
	const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
	if (
		teamDomain === undefined ||
		audience === undefined ||
		!teamDomain.startsWith("https://")
	) {
		// 設定の欠落・不正は到達させない(fail-closed。assertEnvSafetyが先に欠落を拒む)
		return { ok: false, reason: "invalid" };
	}
	try {
		await jwtVerify(
			token,
			async (header) => {
				const kid = header.kid;
				if (typeof kid !== "string") throw new Error("kid missing");
				let keys = keyCache.get(teamDomain);
				let key = keys?.get(kid);
				if (key === undefined) {
					// 未知のkid(初回・鍵の入れ替え)は1回だけ取り直す
					keys = await refreshKeys(teamDomain, fetchFn);
					key = keys.get(kid);
				}
				if (key === undefined) throw new Error("kid unknown");
				return key;
			},
			{ issuer: teamDomain, audience, algorithms: ["RS256"] },
		);
		return { ok: true };
	} catch (error) {
		if (error instanceof JwksUnavailableError) {
			return { ok: false, reason: "jwks_unavailable" };
		}
		return { ok: false, reason: "invalid" };
	}
};
