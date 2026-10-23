/**
 * Intent削除の後始末(docs/05 §2.5)とpause/resumeのVectorize metadata同期
 * (docs/06 §2)の統合試験。
 * - DELETE /v1/intents/{id}: 1対1候補(intent_a/bに含む行)・グループ候補
 *   (intent_idsに含む行)・イベント投入記録(source_intent_id)を削除し、
 *   Vectorizeのベクトルも即時削除する(期限+7日の遅延ではない)。削除対象に
 *   含まれない他人のIntentの候補行・イベント行・ベクトルは残る
 * - pause/resume: ベクトルmetadata.statusをpaused/activeへ即時同期する
 *   (同じvaluesでmetadataだけ書き替え・ベクトル不在時は何もしない)
 * SELF.fetchでWorker全体(index.tsのdefault export)を通してAPIを叩き、D1の行と
 * memoryVectorStoreの実体を直接検証する。ベクトルはEmbedding(Tasks 5のstubでは
 * テスト内でupsertされない)のためmemoryVectorStore()へ直接投入する。
 * 登録済みJWTは実フロー(auth/token→POST /v1/users)で取得する
 * (intents-lifecycle-api.test.tsと同一パターン)。
 */

import { env, SELF } from "cloudflare:test";
import type { IntentDTO } from "@latch/shared";
import { and, eq, or, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importJWK, SignJWT } from "jose";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_IDP_AUDIENCE, TEST_IDP_ISSUER } from "../src/auth/idp";
import {
	groupCandidates,
	intents,
	matchCandidates,
	matchEvents,
} from "../src/db/schema";
// ルートが受け取るEnv(src/env.ts・生成型Envの宣言部分型)
import type { Env as WorkerEnv } from "../src/env";
// テスト間のベクトル汚染除去のためmemory.tsから直接importする(実装の初期化用)
import {
	memoryVectorStore,
	resetMemoryVectorStore,
} from "../src/vectorstore/memory";
import { syncVectorStatus } from "../src/vectorstore/sync-status";
import type { StoredVector } from "../src/vectorstore/types";
import privateJwkText from "./fixtures/test-idp-private.jwk?raw";

const testEnv = env as unknown as WorkerEnv;
const db = drizzle(testEnv.DB);

/** テスト鍵の秘密JWK。viteの?rawでフィクスチャ文字列として読む(workerd内からは実FSを読めないため) */
const privateJwk = JSON.parse(privateJwkText) as {
	kid: string;
} & Record<string, unknown>;

/** 署名鍵を遅延生成する(モジュール評価時に1回だけ) */
let signingKeyPromise: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
	(signingKeyPromise ??= importJWK(privateJwk, "RS256") as Promise<CryptoKey>);

/**
 * テスト鍵でIdPトークンを署名する(docs/04 §4のテスト専用iss/aud)。
 * subは試験ごとにユニークにする
 */
const signIdpToken = async (subject: string): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: subject })
		.setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
		.setIssuer(TEST_IDP_ISSUER)
		.setAudience(TEST_IDP_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(await signingKey());
};

/** JST=UTC+9の固定オフセット(誕生日計算をJST暦日基準に揃える・docs/01 §20) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 「JSTの今日からyears年前」の誕生日('YYYY-MM-DD')。統合試験はsystemClock(実時間)で動く */
const birthDateYearsAgo = (years: number): string => {
	const jstNow = new Date(Date.now() + JST_OFFSET_MS);
	return new Date(
		Date.UTC(
			jstNow.getUTCFullYear() - years,
			jstNow.getUTCMonth(),
			jstNow.getUTCDate(),
		),
	)
		.toISOString()
		.slice(0, 10);
};

/** JSONボディのPOSTリクエストヘルパー */
const postJson = (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

/** ボディ無しPOSTリクエストヘルパー(pause/resumeはボディを受けない) */
const postAction = (path: string, accessToken: string): Promise<Response> =>
	SELF.fetch(`https://localhost${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

/**
 * auth/token→POST /v1/usersで登録済みユーザーを作りアクセストークンを返す実フロー。
 * subjectは試験ごとにユニーク
 */
const registerUser = async (label: string): Promise<string> => {
	const tokenRes = await postJson("/v1/auth/token", {
		provider: "google",
		idp_token: await signIdpToken(`${label}-${crypto.randomUUID()}`),
	});
	expect(tokenRes.status).toBe(200);
	const tokenBody = (await tokenRes.json()) as {
		access_token: string;
		registration_required: boolean;
	};
	expect(tokenBody.registration_required).toBe(true);
	const regRes = await postJson(
		"/v1/users",
		{ display_name: `${label}テスト`, birth_date: birthDateYearsAgo(25) },
		{ Authorization: `Bearer ${tokenBody.access_token}` },
	);
	expect(regRes.status).toBe(201);
	const regBody = (await regRes.json()) as { access_token: string };
	return regBody.access_token;
};

/** つながりactiveを作りDTOを返す */
const createActiveConnection = async (
	accessToken: string,
	topic: string,
): Promise<IntentDTO> => {
	const res = await postJson(
		"/v1/intents",
		{
			raw_text: `${topic}。一緒にやりましょう。`,
			form: "connection",
			topic,
		},
		{ Authorization: `Bearer ${accessToken}` },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as IntentDTO;
};

/** activeのIntentをpauseしDTOを返す(200を試験内で固定) */
const pauseIntent = async (
	accessToken: string,
	intentId: string,
): Promise<IntentDTO> => {
	const res = await postAction(`/v1/intents/${intentId}/pause`, accessToken);
	expect(res.status).toBe(200);
	return (await res.json()) as IntentDTO;
};

/** metadataを補完するヘルパー(form/statusのみ上書きできる・memory.test.tsと同一) */
const makeVector = (
	id: string,
	values: number[],
	metadata?: Partial<StoredVector["metadata"]>,
): StoredVector => ({
	id,
	values,
	metadata: {
		form: "occasion",
		status: "active",
		category: null,
		user_id: "user-1",
		...metadata,
	},
});

/** vi.waitUntilのタイムアウト(waitUntil内のINSERT完了待ち・CIの遅延を吸収) */
const WAIT = { timeout: 5_000, interval: 20 } as const;

/** 起点Intentのイベント投入記録行を取得する */
const eventsOf = (
	intentId: string,
): Promise<(typeof matchEvents.$inferSelect)[]> =>
	db.select().from(matchEvents).where(eq(matchEvents.sourceIntentId, intentId));

/** 1対1候補のうち当該Intentをintent_a/bに含む行を取得する */
const candidatesInvolving = (
	intentId: string,
): Promise<(typeof matchCandidates.$inferSelect)[]> =>
	db
		.select()
		.from(matchCandidates)
		.where(
			or(
				eq(matchCandidates.intentAId, intentId),
				eq(matchCandidates.intentBId, intentId),
			) as SQL,
		);

/** グループ候補のうちintent_idsに当該Intentを含む行を取得する(json配列はJS側で照合) */
const groupsInvolving = async (
	intentId: string,
): Promise<(typeof groupCandidates.$inferSelect)[]> => {
	const rows = await db.select().from(groupCandidates);
	return rows.filter((row) => row.intentIds.includes(intentId));
};

/** 指定ペア(intent_a・intent_b)の1対1候補行を取得する */
const candidateOfPair = (
	intentAId: string,
	intentBId: string,
): Promise<(typeof matchCandidates.$inferSelect)[]> =>
	db
		.select()
		.from(matchCandidates)
		.where(
			and(
				eq(matchCandidates.intentAId, intentAId),
				eq(matchCandidates.intentBId, intentBId),
			),
		);

/** Intent行のuserIdを取得する(ベクトルmetadataのuser_idに使う) */
const userIdOf = async (intentId: string): Promise<string> => {
	const [row] = await db
		.select({ userId: intents.userId })
		.from(intents)
		.where(eq(intents.id, intentId));
	expect(row).toBeDefined();
	return row.userId;
};

/** docs/05 §3.1のエラー応答の形状(details.reasonsに理由コードを載せる場合がある) */
interface ErrorResponse {
	error: { code: string; message: string; details: { reasons?: string[] } };
}

describe("DELETE /v1/intents/{id}の後始末(docs/05 §2.5)", () => {
	beforeEach(() => {
		resetMemoryVectorStore();
	});

	it("削除で1対1候補・グループ候補・イベント・ベクトルが消え、対象外の他人分は残る", async () => {
		const ownerToken = await registerUser("cleanup-del-owner");
		const otherToken = await registerUser("cleanup-del-other");
		const target = await createActiveConnection(
			ownerToken,
			"削除される学習仲間",
		);
		const keptY = await createActiveConnection(otherToken, "残る学習仲間その1");
		const keptZ = await createActiveConnection(otherToken, "残る学習仲間その2");

		// 作成時のintent_createdイベント行(waitUntil内のINSERT)の定着を待つ
		await vi.waitUntil(
			async () => (await eventsOf(target.id)).length >= 1,
			WAIT,
		);
		expect(await eventsOf(keptY.id)).toHaveLength(1);

		// 1対1候補を直接投入(評価確定層は未実装のため)。1行は削除対象を含み、
		// もう1行は含まない(他人分=残るべき行)
		await db.insert(matchCandidates).values([
			{
				id: ulid(),
				intentAId: target.id,
				intentBId: keptY.id,
				intentAVersion: 1,
				intentBVersion: 1,
				form: "connection",
				status: "candidate",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: ulid(),
				intentAId: keptY.id,
				intentBId: keptZ.id,
				intentAVersion: 1,
				intentBVersion: 1,
				form: "connection",
				status: "candidate",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);
		// グループ候補も直接投入。1行はintent_idsに削除対象を含み、もう1行は含まない
		await db.insert(groupCandidates).values([
			{
				id: ulid(),
				intentIds: [target.id, keptY.id, keptZ.id],
				// 実運用の形(ID@versionのカンマ結合・dedupKeyOf)。削除は本人の絞り込みにこの列を使う(#16)
				dedupKey: [target.id, keptY.id, keptZ.id]
					.map((x) => `${x}@1`)
					.join(","),
				aggregateScore: 0.5,
				status: "candidate",
				createdAt: new Date(),
			},
			{
				id: ulid(),
				intentIds: [keptY.id, keptZ.id],
				dedupKey: [keptY.id, keptZ.id].map((x) => `${x}@1`).join(","),
				aggregateScore: 0.4,
				status: "candidate",
				createdAt: new Date(),
			},
		]);
		// ベクトルを直接投入(削除対象と残す対象の2件)
		await memoryVectorStore().upsert([
			makeVector(target.id, [1, 0], {
				form: "connection",
				user_id: await userIdOf(target.id),
			}),
			makeVector(keptY.id, [0, 1], {
				form: "connection",
				user_id: await userIdOf(keptY.id),
			}),
		]);

		const res = await SELF.fetch(`https://localhost/v1/intents/${target.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		expect(res.status).toBe(204);

		// 削除対象: 本体・1対1候補・グループ候補・イベント行が消える
		const [bodyRow] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, target.id));
		expect(bodyRow).toBeUndefined();
		expect(await candidatesInvolving(target.id)).toHaveLength(0);
		expect(await groupsInvolving(target.id)).toHaveLength(0);
		expect(await eventsOf(target.id)).toHaveLength(0);
		// ベクトルも即時削除(期限+7日の遅延ではない・docs/05 §2.5)
		expect(await memoryVectorStore().getByIds([target.id])).toEqual([null]);

		// 対象外(他人のIntent): 候補行・イベント行・ベクトルは残る
		expect(await candidateOfPair(keptY.id, keptZ.id)).toHaveLength(1);
		expect(await groupsInvolving(keptY.id)).toHaveLength(1);
		expect(await eventsOf(keptY.id)).toHaveLength(1);
		const [keptVector] = await memoryVectorStore().getByIds([keptY.id]);
		expect(keptVector?.metadata.status).toBe("active");
	});

	it("ベクトル削除の失敗は500で削除全体を中止する(D1もベクトルも未削除の再試行可能状態)", async () => {
		const accessToken = await registerUser("cleanup-del-vecfail");
		const created = await createActiveConnection(
			accessToken,
			"削除が失敗する学習仲間",
		);
		// 候補子行のFK参照先として同一ユーザーのもう1件のIntentを用意する
		const paired = await createActiveConnection(
			accessToken,
			"候補の参照先になる学習仲間",
		);
		// 作成時のintent_createdイベント行(waitUntil内のINSERT)の定着を待つ
		await vi.waitUntil(
			async () => (await eventsOf(created.id)).length >= 1,
			WAIT,
		);
		// 削除対象になり得る子行(1対1候補)を直接投入
		await db.insert(matchCandidates).values({
			id: ulid(),
			intentAId: created.id,
			intentBId: paired.id,
			intentAVersion: 1,
			intentBVersion: 1,
			form: "connection",
			status: "candidate",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await memoryVectorStore().upsert([
			makeVector(created.id, [1, 0], {
				form: "connection",
				user_id: await userIdOf(created.id),
			}),
		]);

		// deleteByIdsだけを1回失敗させる(Vectorize障害の模擬)
		const deleteSpy = vi
			.spyOn(memoryVectorStore(), "deleteByIds")
			.mockRejectedValueOnce(new Error("vectorize down"));
		const res = await SELF.fetch(`https://localhost/v1/intents/${created.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(500);
		expect(((await res.json()) as ErrorResponse).error.code).toBe("INTERNAL");
		deleteSpy.mockRestore();

		// D1は一切削除されていない(再試行可能)
		const [row] = await db
			.select()
			.from(intents)
			.where(eq(intents.id, created.id));
		expect(row).toBeDefined();
		expect(await candidatesInvolving(created.id)).toHaveLength(1);
		expect(await eventsOf(created.id)).toHaveLength(1);
		// ベクトルも残る(削除は未遂行)
		const [vector] = await memoryVectorStore().getByIds([created.id]);
		expect(vector).not.toBeNull();
	});
});

describe("pause/resumeのVectorize metadata同期(docs/06 §2)", () => {
	beforeEach(() => {
		resetMemoryVectorStore();
	});

	it("pauseはベクトルmetadata.statusをpausedへ同期する(200・valuesと他metadataは不変)", async () => {
		const accessToken = await registerUser("cleanup-pause");
		const created = await createActiveConnection(
			accessToken,
			"一時停止する学習仲間",
		);
		const seeded = makeVector(created.id, [1, 0], {
			form: "connection",
			category: "learning",
			user_id: await userIdOf(created.id),
		});
		await memoryVectorStore().upsert([seeded]);

		const res = await postAction(
			`/v1/intents/${created.id}/pause`,
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).status).toBe("paused");

		// metadata.statusだけがpausedに替わり、valuesと他のmetadataは不変
		const [synced] = await memoryVectorStore().getByIds([created.id]);
		expect(synced?.values).toEqual(seeded.values);
		expect(synced?.metadata).toEqual({ ...seeded.metadata, status: "paused" });
		// pausedは新規候補化の対象外(queryのstatus=activeフィルタで出ない)
		const hits = await memoryVectorStore().query(seeded.values, {
			topK: 10,
			filter: { form: "connection", status: "active" },
		});
		expect(hits).toEqual([]);
	});

	it("resumeはベクトルmetadata.statusをactiveへ戻す(200・intent_updated発行はpipeline-events.test.tsで担保)", async () => {
		const accessToken = await registerUser("cleanup-resume");
		const created = await createActiveConnection(
			accessToken,
			"再開する学習仲間",
		);
		const seeded = makeVector(created.id, [1, 0], {
			form: "connection",
			user_id: await userIdOf(created.id),
		});
		await memoryVectorStore().upsert([seeded]);
		await pauseIntent(accessToken, created.id);
		expect(
			(await memoryVectorStore().getByIds([created.id]))[0]?.metadata.status,
		).toBe("paused");

		const res = await postAction(
			`/v1/intents/${created.id}/resume`,
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).status).toBe("active");

		const [synced] = await memoryVectorStore().getByIds([created.id]);
		expect(synced?.metadata.status).toBe("active");
		expect(synced?.values).toEqual(seeded.values);
		// activeへ戻るため新規候補化の対象に復帰する
		const hits = await memoryVectorStore().query(seeded.values, {
			topK: 10,
			filter: { form: "connection", status: "active" },
		});
		expect(hits).toEqual([{ id: created.id, score: 1 }]);
	});

	it("ベクトルが無いIntentのpauseは200で何もしない(バックフィル回収・docs/06 §2)", async () => {
		const accessToken = await registerUser("cleanup-pause-novec");
		const created = await createActiveConnection(
			accessToken,
			"ベクトルの無い学習仲間",
		);
		expect(await memoryVectorStore().getByIds([created.id])).toEqual([null]);

		const res = await postAction(
			`/v1/intents/${created.id}/pause`,
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as IntentDTO).status).toBe("paused");
		// ベクトルが勝手に作られることもない
		expect(await memoryVectorStore().getByIds([created.id])).toEqual([null]);
	});

	it("同期の失敗は握り潰してpauseの応答は200のまま(best-effort・docs/06 §2)", async () => {
		const accessToken = await registerUser("cleanup-pause-fail");
		const created = await createActiveConnection(
			accessToken,
			"同期が失敗する学習仲間",
		);
		await memoryVectorStore().upsert([
			makeVector(created.id, [1, 0], { form: "connection" }),
		]);
		// metadata同期のupsertだけを1回失敗させる(Vectorize障害の模擬)
		const upsertSpy = vi
			.spyOn(memoryVectorStore(), "upsert")
			.mockRejectedValueOnce(new Error("vectorize down"));

		const res = await postAction(
			`/v1/intents/${created.id}/pause`,
			accessToken,
		);
		expect(res.status).toBe(200);
		// 行はpausedへ遷移している(同期失敗の影響を受けない)
		expect(((await res.json()) as IntentDTO).status).toBe("paused");
		upsertSpy.mockRestore();
		// ベクトルは同期前のactiveのまま(Cronのバックフィルで回収される)
		const [stale] = await memoryVectorStore().getByIds([created.id]);
		expect(stale?.metadata.status).toBe("active");
	});

	it("同期がベクトルを読んだ後に意思が削除されたら、ベクトルを書き戻さない(#20)", async () => {
		const accessToken = await registerUser("cleanup-pause-deleted");
		const created = await createActiveConnection(
			accessToken,
			"同期と削除が競合する学習仲間",
		);
		await memoryVectorStore().upsert([
			makeVector(created.id, [1, 0], { form: "connection" }),
		]);
		const store = memoryVectorStore();
		const original = store.getByIds.bind(store);
		vi.spyOn(store, "getByIds").mockImplementation(async (ids) => {
			const found = await original(ids);
			if (ids.includes(created.id)) {
				// 削除APIと同じ順(ベクトル→子の行→意思の行・docs/05 §2.5)
				await store.deleteByIds([created.id]);
				await db
					.delete(matchCandidates)
					.where(
						or(
							eq(matchCandidates.intentAId, created.id),
							eq(matchCandidates.intentBId, created.id),
						) as SQL,
					);
				await db
					.delete(matchEvents)
					.where(eq(matchEvents.sourceIntentId, created.id));
				await db.delete(intents).where(eq(intents.id, created.id));
			}
			return found;
		});

		const res = await postAction(
			`/v1/intents/${created.id}/pause`,
			accessToken,
		);
		expect(res.status).toBe(200);
		expect(await original([created.id])).toEqual([null]);
	});

	it("意思の行のstatusが同期先と違えば書かない(後から来た再開を古い一時停止で上書きしない・#20)", async () => {
		const accessToken = await registerUser("cleanup-sync-mismatch");
		const created = await createActiveConnection(
			accessToken,
			"同期先と行が食い違う学習仲間",
		);
		await memoryVectorStore().upsert([
			makeVector(created.id, [1, 0], { form: "connection" }),
		]);

		// 行はactiveのまま、pausedへの同期だけが遅れて届いた状況
		await syncVectorStatus(testEnv, created.id, "paused");

		const [vector] = await memoryVectorStore().getByIds([created.id]);
		expect(vector?.metadata.status).toBe("active");
	});
});
