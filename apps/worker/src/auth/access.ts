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

/** 公開鍵の集合(JWK)のKVでの保持秒数(10分)。#32 */
export const ACCESS_CERTS_CACHE_TTL_S = 600;

type CertsBody = { keys?: Array<JWK & { kid?: string }> };

const certsUrlOf = (teamDomain: string): string =>
	`${teamDomain}/cdn-cgi/access/certs`;

const certsKvKey = (teamDomain: string): string => `access:certs:${teamDomain}`;

/**
 * 試験用: isolate内の公開鍵のキャッシュを空にし、envとチームのドメインを渡したときは
 * KVの置き場も空にする。新しいisolateの初回を模すために使う
 */
export const resetAccessKeyCacheForTest = async (
	env?: Pick<Env, "PIPELINE_KV">,
	teamDomain?: string,
): Promise<void> => {
	keyCache.clear();
	if (env === undefined || teamDomain === undefined) return;
	try {
		await env.PIPELINE_KV.delete(certsKvKey(teamDomain));
	} catch {
		// 置き場が使えない環境では何もしない
	}
};

/**
 * #32: isolateごとの初回に証明書の集合を取ると約0.45秒かかり、負荷でisolateが
 * 次々に立つと保存のp95を押し上げた。そこでKV(PIPELINE_KV)で使い回す。
 * Cache APIはworkers.devのデプロイでは何も保存しないため使えない(stagingがworkers.dev)。
 * 置くのは公開鍵のJWKの集合の本文だけ(秘密の値は含まない)。読み書きの失敗は取得に落とす。
 * 入れ替え・失効したkidは、isolateが入れ替わるまでisolate内に、KVには最大600秒残りうる
 * (失効の意味は従来どおり)
 */
const readCertsKv = async (
	env: Pick<Env, "PIPELINE_KV">,
	teamDomain: string,
): Promise<CertsBody | undefined> => {
	try {
		const text = await env.PIPELINE_KV.get(certsKvKey(teamDomain));
		if (text === null) return undefined;
		const body = JSON.parse(text) as CertsBody | null;
		// 形の崩れた値(keysが配列でない)は使わずに取得へ進む。使うとimportKeysが例外になり、
		// KVの保持秒数(最大600秒)の間403を返し続けるため
		return body !== null && Array.isArray(body.keys) ? body : undefined;
	} catch {
		return undefined;
	}
};

const writeCertsKv = async (
	env: Pick<Env, "PIPELINE_KV">,
	teamDomain: string,
	body: CertsBody,
): Promise<void> => {
	try {
		await env.PIPELINE_KV.put(certsKvKey(teamDomain), JSON.stringify(body), {
			expirationTtl: ACCESS_CERTS_CACHE_TTL_S,
		});
	} catch {
		// 保存できなくても検証は続ける
	}
};

/** JWKの集合を鍵の表へ読み込む(読めない鍵は無視する。該当kidの証明はinvalidになる) */
const importKeys = async (
	body: CertsBody,
): Promise<Map<string, CryptoKey | Uint8Array>> => {
	const keys = new Map<string, CryptoKey | Uint8Array>();
	for (const jwk of body.keys ?? []) {
		if (typeof jwk.kid !== "string") continue;
		try {
			keys.set(jwk.kid, await importJWK(jwk, "RS256"));
		} catch {
			// 読めない鍵は無視する
		}
	}
	return keys;
};

/** チームのドメインのJWKSを取り直してキャッシュ(isolate内とKV)を置き換える */
const refreshKeys = async (
	env: Pick<Env, "PIPELINE_KV">,
	teamDomain: string,
	fetchFn: typeof fetch,
): Promise<Map<string, CryptoKey | Uint8Array>> => {
	const url = certsUrlOf(teamDomain);
	let body: CertsBody;
	try {
		const response = await fetchFn(url);
		if (!response.ok) {
			throw new JwksUnavailableError(`status ${response.status}`);
		}
		body = (await response.json()) as CertsBody;
	} catch (error) {
		throw error instanceof JwksUnavailableError
			? error
			: new JwksUnavailableError(String(error));
	}
	const keys = await importKeys(body);
	// 空の鍵集合では既存の鍵を捨てない(一時的な異常で全kidが失効するのを避ける)
	if (keys.size === 0) {
		return keyCache.get(teamDomain) ?? keys;
	}
	keyCache.set(teamDomain, keys);
	await writeCertsKv(env, teamDomain, body);
	return keys;
};

/** 新しいisolateの初回: KVの集合をisolate内へ読み込む(無ければ空) */
const loadKeysFromCache = async (
	env: Pick<Env, "PIPELINE_KV">,
	teamDomain: string,
): Promise<Map<string, CryptoKey | Uint8Array> | undefined> => {
	const body = await readCertsKv(env, teamDomain);
	if (body === undefined) return undefined;
	const keys = await importKeys(body);
	if (keys.size === 0) return undefined;
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
				if (keys === undefined) {
					// isolateの初回はKVを先に見る(#32)
					keys = await loadKeysFromCache(env, teamDomain);
				}
				let key = keys?.get(kid);
				if (key === undefined) {
					// 未知のkid(KVにも無い・鍵の入れ替え)はKVを使わず1回だけ取り直す
					keys = await refreshKeys(env, teamDomain, fetchFn);
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
