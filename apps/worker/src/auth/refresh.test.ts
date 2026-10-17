/**
 * リフレッシュトークン(回転・猶予・再利用検出)の統合試験(docs/04 §4・docs/05 §2.2/§2.3)。
 * D1・KVの実バインディング(vitest-pool-workersのminiflareエミュレータ)で行う。
 * 時刻はfixedClockで固定する(docs/04 §4の時刻の規律)。テスト間の分離のため
 * ユーザー・族は各試験で新規に作る(ULIDは毎回異なる)
 */
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock/clock";
import { refreshFamilies, users } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";
import {
	createRefreshFamily,
	GRACE_WINDOW_SECONDS,
	generateRefreshToken,
	REFRESH_GRACE_KV_PREFIX,
	REFRESH_TTL_DAYS,
	revokeFamilyByToken,
	rotateRefreshToken,
	sha256Hex,
} from "./refresh";

const testEnv = env as unknown as Env;
const db = drizzle(testEnv.DB);

/** テストの基準時刻(fixedClockで固定・実時間に依存しない) */
const BASE_MS = Date.parse("2026-10-18T00:00:00.000Z");
const clock = fixedClock(new Date(BASE_MS));

/** refresh_families.user_idのFK(users.id)を満たすためユーザー行を作る(docs/05 §2.2) */
const createUser = async (): Promise<string> => {
	const userId = newUlid();
	const now = new Date(BASE_MS);
	await db.insert(users).values({
		id: userId,
		authProvider: "google",
		authSubject: `test-subject-${userId}`,
		actorType: "individual",
		displayName: "テストユーザー",
		bio: "",
		birthDate: "2000-01-01",
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	return userId;
};

/** 族IDで行を取り出す(検証用) */
const familyById = async (familyId: string) => {
	const [family] = await db
		.select()
		.from(refreshFamilies)
		.where(eq(refreshFamilies.id, familyId));
	return family;
};

describe("リフレッシュトークンの生成(docs/04 §4: 32バイト乱数→base64url)", () => {
	it("定数はdocs/04 §4・docs/05 §2.3の確定値(30日・120秒・rfg:接頭辞)", () => {
		expect(REFRESH_TTL_DAYS).toBe(30);
		expect(GRACE_WINDOW_SECONDS).toBe(120);
		expect(REFRESH_GRACE_KV_PREFIX).toBe("rfg:");
	});

	it("generateRefreshTokenは43文字のbase64urlトークンとそのSHA-256ハッシュを返す", async () => {
		const { token, hash } = await generateRefreshToken();
		// 32バイト=256bit→base64(パディング2文字)→base64urlでパディングを除き43文字
		expect(token).toHaveLength(43);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(hash).toBe(await sha256Hex(token));
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("rotateRefreshTokenの回転(docs/04 §4: 回転式30日)", () => {
	it("現行トークンの提示で新トークンが発行され、previous_hashが旧ハッシュ・expires_atが+30日になる", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);

		const result = await rotateRefreshToken(testEnv, clock, token);
		if (!result.ok) {
			throw new Error(`回転が失敗した: ${JSON.stringify(result)}`);
		}
		expect(result.userId).toBe(userId);
		expect(result.refreshToken).not.toBe(token);

		const family = await familyById(familyId);
		expect(family.previousHash).toBe(await sha256Hex(token));
		expect(family.currentHash).toBe(await sha256Hex(result.refreshToken));
		expect(family.rotatedAt.getTime()).toBe(BASE_MS);
		expect(family.expiresAt.getTime()).toBe(
			BASE_MS + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
		);
		expect(family.status).toBe("active");
	});
});

describe("回転猶予(docs/04 §4: 応答喪失後の同一旧トークン再提示は1回だけ現行トークンを再返す)", () => {
	it("回転直後の旧トークン再提示はKVに保存済みの現行トークンを返し、KVキーは使い切りで消える", async () => {
		const userId = await createUser();
		const oldToken = (await createRefreshFamily(testEnv, clock, userId)).token;
		const rotated = await rotateRefreshToken(testEnv, clock, oldToken);
		if (!rotated.ok) {
			throw new Error("回転が失敗した");
		}
		const graceKey = REFRESH_GRACE_KV_PREFIX + (await sha256Hex(oldToken));
		// 回転直後は猶予キーが現行トークンを保持している(docs/05 §2.3)
		expect(await testEnv.REVOCATION_KV.get(graceKey)).toBe(
			rotated.refreshToken,
		);

		const retry = await rotateRefreshToken(testEnv, clock, oldToken);
		if (!retry.ok) {
			throw new Error("猶予が失敗した");
		}
		expect(retry.userId).toBe(userId);
		// KVに保存済みの現行トークンがそのまま再返却される(新発行ではない)
		expect(retry.refreshToken).toBe(rotated.refreshToken);
		// 返却後にキーは削除される(使い切り)
		expect(await testEnv.REVOCATION_KV.get(graceKey)).toBeNull();
	});

	it("猶予使い切り後の旧トークン再提示はUNAUTHORIZEDとなり族はrevokedになる(docs/04 §4)", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);
		const rotated = await rotateRefreshToken(testEnv, clock, token);
		if (!rotated.ok) {
			throw new Error("回転が失敗した");
		}
		// 1回目の再提示で猶予を使い切る
		const retry = await rotateRefreshToken(testEnv, clock, token);
		if (!retry.ok) {
			throw new Error("猶予が失敗した");
		}

		// 2回目の再提示: 猶予キーは既に無く、再利用検出として族がrevokedになる
		const second = await rotateRefreshToken(testEnv, clock, token);
		expect(second).toEqual({ ok: false, code: "UNAUTHORIZED" });

		const family = await familyById(familyId);
		expect(family.status).toBe("revoked");
	});

	it("猶予窓の経過(KVキーの手動削除)後の旧トークン提示は再利用検出で族revoked+UNAUTHORIZED(docs/04 §4)", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);
		const rotated = await rotateRefreshToken(testEnv, clock, token);
		if (!rotated.ok) {
			throw new Error("回転が失敗した");
		}
		// TTL 120秒の経過をKVキーの削除で模擬する
		await testEnv.REVOCATION_KV.delete(
			REFRESH_GRACE_KV_PREFIX + (await sha256Hex(token)),
		);

		const result = await rotateRefreshToken(testEnv, clock, token);
		expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });

		const family = await familyById(familyId);
		expect(family.status).toBe("revoked");
	});
});

describe("rotateRefreshTokenの失敗系(docs/05 §3.1: TOKEN_EXPIRED/UNAUTHORIZED)", () => {
	it("expires_at経過後の現行トークンはTOKEN_EXPIREDとなり、族はactiveのまま", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);
		// 期限切れを作る: 行のexpires_atを直接過去へ更新する(回転は起きない)
		await db
			.update(refreshFamilies)
			.set({ expiresAt: new Date(BASE_MS - 1000) })
			.where(eq(refreshFamilies.id, familyId));

		const result = await rotateRefreshToken(testEnv, clock, token);
		expect(result).toEqual({ ok: false, code: "TOKEN_EXPIRED" });

		const family = await familyById(familyId);
		expect(family.status).toBe("active");
		// 期限切れでは回転・失効とも行われない
		expect(family.currentHash).toBe(await sha256Hex(token));
	});

	it("失効済み族の現行トークンはUNAUTHORIZED", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);
		await db
			.update(refreshFamilies)
			.set({ status: "revoked" })
			.where(eq(refreshFamilies.id, familyId));

		const result = await rotateRefreshToken(testEnv, clock, token);
		expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
	});

	it("未知トークン(でっち上げ)はUNAUTHORIZEDで族への影響はない", async () => {
		await createUser();
		const result = await rotateRefreshToken(
			testEnv,
			clock,
			"forged-token-that-matches-no-family",
		);
		expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
	});
});

describe("revokeFamilyByToken(docs/05 §2.5: ログアウト時の失効)", () => {
	it("現行トークンが属する族をrevokedにする", async () => {
		const userId = await createUser();
		const { token, familyId } = await createRefreshFamily(
			testEnv,
			clock,
			userId,
		);

		await revokeFamilyByToken(testEnv, token);

		const family = await familyById(familyId);
		expect(family.status).toBe("revoked");
	});
});
