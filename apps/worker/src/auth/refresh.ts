/**
 * リフレッシュトークン(回転式・30日)の発行・回転・失効(docs/04 §4・docs/05 §2.2/§2.3)。
 * - 回転は current_hash の条件付きUPDATE(CAS)+RETURNINGで原子的に行う(docs/05 §2.2: UNIQUE索引)
 * - 応答喪失後の同一旧トークン再提示は1回に限り現行トークンを再返す猶予を持つ
 *   (回転時にKV `rfg:{旧ハッシュ}` へ現行トークンをTTL 120秒で保存し、再提示時に取得後削除で使い切り)
 * - 猶予窓外の旧トークン再提示は再利用検出として族をrevokedにする(docs/04 §4)
 * 時刻の規律(docs/04 §4): 実時間を直接参照しない。現在時刻は引数のclock経由でのみ受け取る
 */

import { and, eq, gt, lt } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Clock } from "../clock/clock";
import { refreshFamilies } from "../db/schema";
import type { Env } from "../env";
import { newUlid } from "../ids";

/** リフレッシュトークンの有効期限(日)。docs/04 §4: 回転式(30日)・回転ごとに延長する */
export const REFRESH_TTL_DAYS = 30;

/**
 * 回転猶予窓(秒)。docs/04 §4: 応答喪失の再試行は秒単位で終わるため、この窓を過ぎた
 * 旧トークンは再利用検出に合流する。KVのexpirationTtl下限(60秒)を満たす値
 */
export const GRACE_WINDOW_SECONDS = 120;

/** 回転猶予のKVキー接頭辞(docs/05 §2.3: `rfg:{旧リフレッシュトークンハッシュ}`=現行トークン) */
export const REFRESH_GRACE_KV_PREFIX = "rfg:";

/** 1日のミリ秒(expires_at=now+30日の計算用) */
const DAY_MS = 24 * 60 * 60 * 1000;

/** D1接続。envのバインディングからdrizzleインスタンスを作る(軽量オブジェクトのため関数ごとの生成でよい) */
const dbOf = (env: Env): DrizzleD1Database => drizzle(env.DB);

/** SHA-256ハッシュの16進表記(64文字)。WorkersのWeb標準crypto.subtleで完結する(docs/05 §2.2) */
export const sha256Hex = async (s: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(s),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

/**
 * 32バイト乱数からbase64urlのリフレッシュトークンとそのSHA-256ハッシュを生成する
 * (docs/04 §4)。DBにはハッシュのみを保存し、トークン本体は応答で一度だけ返す。
 * ハッシュはcrypto.subtle(非同期)で計算するため本関数もasync
 */
export const generateRefreshToken = async (): Promise<{
	token: string;
	hash: string;
}> => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	// base64 → base64url(RFC 4648 §5・パディングなし)
	const token = btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	return { token, hash: await sha256Hex(token) };
};

/** 新しいリフレッシュトークン族を作る(INSERT・expires_at=now+30日・docs/04 §4) */
export const createRefreshFamily = async (
	env: Env,
	clock: Clock,
	userId: string,
): Promise<{ token: string; familyId: string }> => {
	const db = dbOf(env);
	const now = clock.now();
	const { token, hash } = await generateRefreshToken();
	const familyId = newUlid();
	await db.insert(refreshFamilies).values({
		id: familyId,
		userId,
		currentHash: hash,
		previousHash: null,
		expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS * DAY_MS),
		status: "active",
		createdAt: now,
		rotatedAt: now,
	});
	return { token, familyId };
};

/**
 * 回転の結果。ok=trueは新トークン(猶予では回転時に保存した現行トークンの再返却)、
 * ok=falseはdocs/05 §3.1のエラー対応先(UNAUTHORIZED=401 / TOKEN_EXPIRED=再ログイン)
 */
export type RotateResult =
	| { ok: true; userId: string; refreshToken: string }
	| { ok: false; code: "UNAUTHORIZED" | "TOKEN_EXPIRED" };

/**
 * リフレッシュトークンを検証し、可能なら回転させる(docs/04 §4の設計どおり):
 * 1. CAS回転成功 → KV `rfg:{提示ハッシュ}` に新トークンをTTL=GRACE_WINDOW_SECONDSで保存し {ok:true}
 * 2. 現行ハッシュの行あり → status≠activeならUNAUTHORIZED / 期限切れならTOKEN_EXPIRED
 * 3. 行なし+猶予キーあり → キーを削除(使い切り)のうえ現行トークンを再返却
 * 4. 猶予キーなし+previous_hash一致のactive族(回転が猶予窓外) → 再利用検出:
 *    族をrevokedにしてUNAUTHORIZED。回転が猶予窓内のときはKV猶予エントリが結果整合に
 *    よりまだ見えない競合の可能性があるため族は失効させずUNAUTHORIZEDのみ(docs/05 §2.3)
 * 5. いずれでもない未知トークン → UNAUTHORIZED(族を特定できないため失効対象なし)
 */
export const rotateRefreshToken = async (
	env: Env,
	clock: Clock,
	presentedToken: string,
): Promise<RotateResult> => {
	const db = dbOf(env);
	const now = clock.now();
	const presentedHash = await sha256Hex(presentedToken);
	const next = await generateRefreshToken();

	// 1. CAS回転(docs/05 §2.2: current_hashのUNIQUE索引を検索に使い、条件付きUPDATE+RETURNINGで原子的に)
	const rotated = await db
		.update(refreshFamilies)
		.set({
			currentHash: next.hash,
			previousHash: presentedHash,
			rotatedAt: now,
			expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS * DAY_MS),
		})
		.where(
			and(
				eq(refreshFamilies.currentHash, presentedHash),
				eq(refreshFamilies.status, "active"),
				gt(refreshFamilies.expiresAt, now),
			),
		)
		.returning({ userId: refreshFamilies.userId });

	if (rotated.length > 0) {
		// 猶予用に旧ハッシュ→新トークンをKVへ置く(docs/05 §2.3・TTL=GRACE_WINDOW_SECONDS)
		await env.REVOCATION_KV.put(
			REFRESH_GRACE_KV_PREFIX + presentedHash,
			next.token,
			{ expirationTtl: GRACE_WINDOW_SECONDS },
		);
		return { ok: true, userId: rotated[0].userId, refreshToken: next.token };
	}

	// 2. CASが0行のとき、現行ハッシュの行があれば理由は status か期限切れ(docs/05 §3.1)
	const [current] = await db
		.select()
		.from(refreshFamilies)
		.where(eq(refreshFamilies.currentHash, presentedHash));
	if (current !== undefined) {
		if (current.status !== "active") {
			return { ok: false, code: "UNAUTHORIZED" };
		}
		// activeで現行一致ならCAS不成立の理由は期限切れのみ
		return { ok: false, code: "TOKEN_EXPIRED" };
	}

	// 3. 猶予: 回転時に保存した現行トークンを1回だけ再返す(docs/04 §4)
	const graceKey = REFRESH_GRACE_KV_PREFIX + presentedHash;
	const graceToken = await env.REVOCATION_KV.get(graceKey);
	if (graceToken !== null) {
		// 取得後に削除で使い切り(3回目の再提示は再利用検出に合流する)
		await env.REVOCATION_KV.delete(graceKey);
		const [family] = await db
			.select({ userId: refreshFamilies.userId })
			.from(refreshFamilies)
			.where(
				and(
					eq(refreshFamilies.previousHash, presentedHash),
					eq(refreshFamilies.status, "active"),
					gt(refreshFamilies.expiresAt, now),
				),
			);
		if (family !== undefined) {
			return { ok: true, userId: family.userId, refreshToken: graceToken };
		}
		// 族が既に失効している等は猶予不成立。次の再利用検出判定へ落ちる
	}

	// 4. 再利用検出: previous_hash一致のactive族のうち回転が猶予窓外のものを失効させる
	// (docs/04 §4)。回転が猶予窓内のときはCAS回転後のKV put完了前に同一旧トークンが
	// 再提示され、猶予エントリが結果整合によりまだ見えない競合が起こりえる。この場合は
	// 正規セッションの誤失効を避けるため族は失効させず401のみ(docs/05 §2.3)。
	// ユーザーごとの族数は多くないため previous_hash による走査は全走査を許容し索引は追加しない
	const [reused] = await db
		.select({ id: refreshFamilies.id })
		.from(refreshFamilies)
		.where(
			and(
				eq(refreshFamilies.previousHash, presentedHash),
				eq(refreshFamilies.status, "active"),
				lt(
					refreshFamilies.rotatedAt,
					new Date(now.getTime() - GRACE_WINDOW_SECONDS * 1000),
				),
			),
		);
	if (reused !== undefined) {
		await db
			.update(refreshFamilies)
			.set({ status: "revoked" })
			.where(eq(refreshFamilies.id, reused.id));
		return { ok: false, code: "UNAUTHORIZED" };
	}

	// 5. 未知トークン: 族を特定できないため失効対象なし(docs/04 §4)
	return { ok: false, code: "UNAUTHORIZED" };
};

/**
 * ログアウト用: 現行リフレッシュトークンが属する族を失効させる(docs/05 §2.5)。
 * 既に失効済みの族への再実行も結果は同じ(冪等)。該当族が無い場合は何もしない
 */
export const revokeFamilyByToken = async (
	env: Env,
	token: string,
): Promise<void> => {
	const db = dbOf(env);
	const hash = await sha256Hex(token);
	await db
		.update(refreshFamilies)
		.set({ status: "revoked" })
		.where(eq(refreshFamilies.currentHash, hash));
};
