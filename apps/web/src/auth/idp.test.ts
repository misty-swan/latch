/**
 * 本番IdPの部品(auth/idp.ts・docs/04 §4)の単体試験。
 * 認可画面への移動は差し替えたassignで受け取り、戻りはURLの#以降を組み立てて渡す(本物のIdPには接続しない)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	completeIdpRedirect,
	IDP_PENDING_MAX_AGE_MS,
	idpRedirectUri,
	isIdpConfigured,
	startIdpRedirect,
} from "./idp";

/** 署名の無いIDトークン風の値(ペイロードのnonceだけを画面側が読む) */
const fakeIdToken = (payload: Record<string, unknown>): string => {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
};

/** 出発して、認可画面のURLを返す */
const start = (
	provider: "google" | "apple",
	purpose: "signin" | "withdraw" = "signin",
	now = 1_000_000,
): URL => {
	const assign = vi.fn();
	expect(startIdpRedirect(provider, purpose, assign, () => now)).toBe(true);
	expect(assign).toHaveBeenCalledTimes(1);
	return new URL(String(assign.mock.calls[0]?.[0]));
};

beforeEach(() => {
	sessionStorage.clear();
	vi.stubEnv(
		"VITE_GOOGLE_CLIENT_ID",
		"google-client.apps.googleusercontent.com",
	);
	vi.stubEnv("VITE_APPLE_CLIENT_ID", "jp.example.latch.web");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("client idの有無", () => {
	it("空文字は未設定として扱い、移動しない", () => {
		vi.stubEnv("VITE_APPLE_CLIENT_ID", "");
		const assign = vi.fn();

		expect(isIdpConfigured("google")).toBe(true);
		expect(isIdpConfigured("apple")).toBe(false);
		expect(startIdpRedirect("apple", "signin", assign)).toBe(false);
		expect(assign).not.toHaveBeenCalled();
		expect(sessionStorage.length).toBe(0);
	});
});

describe("認可画面のURL", () => {
	it("Googleは暗黙フロー(response_type=id_token・scope=openid)で、戻り先は/auth/callback", () => {
		const url = start("google");

		expect(`${url.origin}${url.pathname}`).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("client_id")).toBe(
			"google-client.apps.googleusercontent.com",
		);
		expect(url.searchParams.get("redirect_uri")).toBe(
			`${window.location.origin}/auth/callback`,
		);
		expect(url.searchParams.get("redirect_uri")).toBe(idpRedirectUri());
		expect(url.searchParams.get("response_type")).toBe("id_token");
		expect(url.searchParams.get("scope")).toBe("openid");
		expect(url.searchParams.get("prompt")).toBe("select_account");
		expect(url.searchParams.get("state")?.length).toBeGreaterThanOrEqual(40);
		expect(url.searchParams.get("nonce")?.length).toBeGreaterThanOrEqual(40);
	});

	it("Appleはscope無しでfragmentに受け取る(response_type=code id_token)", () => {
		const url = start("apple");

		expect(`${url.origin}${url.pathname}`).toBe(
			"https://appleid.apple.com/auth/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe("jp.example.latch.web");
		expect(url.searchParams.get("response_type")).toBe("code id_token");
		expect(url.searchParams.get("response_mode")).toBe("fragment");
		expect(url.searchParams.has("scope")).toBe(false);
	});

	it("stateとnonceは出発ごとに変わる", () => {
		const first = start("google");
		const second = start("google");

		expect(first.searchParams.get("state")).not.toBe(
			second.searchParams.get("state"),
		);
		expect(first.searchParams.get("nonce")).not.toBe(
			second.searchParams.get("nonce"),
		);
	});
});

describe("戻りの照合", () => {
	const returnHash = (
		url: URL,
		overrides: Record<string, string> = {},
	): string => {
		const params = new URLSearchParams({
			state: url.searchParams.get("state") ?? "",
			id_token: fakeIdToken({ nonce: url.searchParams.get("nonce") }),
			...overrides,
		});
		return `#${params.toString()}`;
	};

	it("stateとnonceが合えば、IDトークン・IdP・目的を返す", () => {
		const url = start("apple", "withdraw");
		const hash = returnHash(url);

		const result = completeIdpRedirect(hash, () => 1_000_000 + 60_000);

		expect(result).toEqual({
			ok: true,
			provider: "apple",
			purpose: "withdraw",
			idToken: new URLSearchParams(hash.slice(1)).get("id_token"),
		});
	});

	it("控えは1回で捨てる(同じ戻りを2回は受け付けない)", () => {
		const url = start("google");
		const hash = returnHash(url);

		expect(completeIdpRedirect(hash, () => 1_000_000).ok).toBe(true);
		expect(completeIdpRedirect(hash, () => 1_000_000)).toEqual({
			ok: false,
			reason: "failed",
		});
	});

	it("出発していない戻りは失敗(目的は分からない)", () => {
		expect(completeIdpRedirect("#state=x&id_token=y")).toEqual({
			ok: false,
			reason: "failed",
		});
	});

	it("stateが違えば失敗", () => {
		const url = start("google");

		expect(
			completeIdpRedirect(returnHash(url, { state: "other" }), () => 1_000_000),
		).toEqual({ ok: false, purpose: "signin", reason: "failed" });
	});

	it("nonceが違えば失敗", () => {
		const url = start("google");

		expect(
			completeIdpRedirect(
				returnHash(url, { id_token: fakeIdToken({ nonce: "other" }) }),
				() => 1_000_000,
			),
		).toEqual({ ok: false, purpose: "signin", reason: "failed" });
	});

	it("IDトークンが無ければ失敗", () => {
		const url = start("google");
		const hash = `#state=${url.searchParams.get("state")}`;

		expect(completeIdpRedirect(hash, () => 1_000_000)).toEqual({
			ok: false,
			purpose: "signin",
			reason: "failed",
		});
	});

	it("出発から10分を超えた戻りは失敗", () => {
		const url = start("google", "withdraw");

		expect(
			completeIdpRedirect(
				returnHash(url),
				() => 1_000_000 + IDP_PENDING_MAX_AGE_MS + 1,
			),
		).toEqual({ ok: false, purpose: "withdraw", reason: "failed" });
	});

	it("利用者の取り消し(Googleのaccess_denied・Appleのuser_cancelled_authorize)はcancelled", () => {
		const google = start("google");
		expect(
			completeIdpRedirect(
				`#state=${google.searchParams.get("state")}&error=access_denied`,
				() => 1_000_000,
			),
		).toEqual({ ok: false, purpose: "signin", reason: "cancelled" });

		const apple = start("apple");
		expect(
			completeIdpRedirect(
				`#state=${apple.searchParams.get("state")}&error=user_cancelled_authorize`,
				() => 1_000_000,
			),
		).toEqual({ ok: false, purpose: "signin", reason: "cancelled" });
	});

	it("それ以外のerrorはfailed", () => {
		const url = start("google");

		expect(
			completeIdpRedirect(
				`#state=${url.searchParams.get("state")}&error=server_error`,
				() => 1_000_000,
			),
		).toEqual({ ok: false, purpose: "signin", reason: "failed" });
	});
});
