/**
 * 退会のE2E(APIレベル・DELETE /v1/users/me・docs/05 §2.5・§3.3・LAT-94・docs/10 §4のF9の退会の試験)。
 * 実際のパイプラインで成立させた1対1のLATCHから片方が退会し、wrangler devの実プロセスで
 * 再認証の拒否・相手の側の見え方(終了・「つながっていた相手」・メッセージは残る)・
 * 退会者のトークンの失効と再登録の扱いを確かめる。
 *
 * 配置はchat.spec.tsと同じ(新規ユーザー・各testの前にscripts/clean-e2e-data.mjsで他specの残置Intentを
 * expiredへ倒す)。他specの地域と重ならない緯度39度台に置く
 */

import { execSync } from "node:child_process";
import path from "node:path";
import type { LatchDTO, MessageDTO } from "@latch/shared";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	createIntent,
	type RegisteredUser,
	registerUser,
	respond,
	signIdpToken,
	waitFor,
	waitForLatch,
} from "./helpers";

const workerDir = path.join(import.meta.dirname, "..");

const auth = (user: RegisteredUser): Record<string, string> => ({
	authorization: `Bearer ${user.access_token}`,
});

/** 指定Intentの第2段の評価(embedding_completed)がprocessedになるまで待つ */
const waitForEvaluation = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<void> => {
	await waitFor(
		async () => {
			const res = await request.get(
				`/v1/dev/match-events?intent_id=${intentId}&limit=50`,
				{ headers: auth(user) },
			);
			const items = ((await res.json()) as { items: Record<string, unknown>[] })
				.items;
			return items.some(
				(e) =>
					e.event_type === "embedding_completed" && e.status === "processed",
			);
		},
		60_000,
		500,
	);
};

/** 1対1のつながりLATCHを両者yesで成立させる */
const matchPair = async (request: APIRequestContext) => {
	const topic = "週末に古い映画を観て感想を話せる仲間を探しています";
	const geo = { center: { lat: 39.0055, lng: 131.5055 }, radius_m: 1_000 };
	const make = (user: RegisteredUser) =>
		createIntent(request, user.access_token, {
			raw_text: topic,
			form: "connection",
			topic,
			geo,
		});
	const a = await registerUser(request, "E2E退会A");
	const x = await make(a);
	await waitForEvaluation(request, a, x.id);
	const b = await registerUser(request, "E2E退会B");
	const y = await make(b);
	await waitForEvaluation(request, b, y.id);
	const latch = await waitForLatch(
		request,
		a.access_token,
		x.id,
		(i) => i.intent_ids.includes(x.id) && i.intent_ids.includes(y.id),
	);
	await respond(request, a.access_token, latch.id, "yes");
	expect((await respond(request, b.access_token, latch.id, "yes")).status).toBe(
		"matched",
	);
	return { a, b, x, y, latchId: latch.id };
};

test.setTimeout(180_000);

test.beforeEach(() => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: workerDir,
		stdio: "ignore",
	});
});

test("退会: 再認証のうえ本人のデータを消し、成立中のつながりは相手の側で終了として残る", async ({
	request,
}) => {
	const pair = await matchPair(request);
	const sent = await request.post(`/v1/latches/${pair.latchId}/messages`, {
		data: { body: "退会する前のあいさつ", client_id: "c-a-1" },
		headers: auth(pair.a),
	});
	expect(sent.status()).toBe(201);

	// 別のアカウントのIdPトークンでは退会しない(403・何も変わらない)
	const wrong = await request.delete("/v1/users/me", {
		data: {
			provider: "google",
			idp_token: await signIdpToken(`e2e-${crypto.randomUUID()}`),
		},
		headers: auth(pair.a),
	});
	expect(wrong.status()).toBe(403);
	expect(
		(await request.get("/v1/users/me", { headers: auth(pair.a) })).status(),
	).toBe(200);

	// 本人のアカウントで確かめ直すと退会できる
	const res = await request.delete("/v1/users/me", {
		data: { provider: "google", idp_token: await signIdpToken(pair.a.subject) },
		headers: auth(pair.a),
	});
	expect(res.status()).toBe(204);

	// 退会者のアクセストークンは失効している
	expect(
		(await request.get("/v1/users/me", { headers: auth(pair.a) })).status(),
	).toBe(401);

	// 相手の側: つながりは終了(読み取り専用)・名前は出さない・メッセージは残る
	const seen = await request.get(`/v1/latches/${pair.latchId}`, {
		headers: auth(pair.b),
	});
	expect(seen.status()).toBe(200);
	const dto = (await seen.json()) as LatchDTO;
	expect(dto.status).toBe("cancelled");
	expect(dto.members?.map((m) => m.display_name)).toEqual([
		"つながっていた相手",
	]);
	const history = await request.get(`/v1/latches/${pair.latchId}/messages`, {
		headers: auth(pair.b),
	});
	const { items } = (await history.json()) as { items: MessageDTO[] };
	expect(items.map((m) => m.body)).toEqual(["退会する前のあいさつ"]);
	const send = await request.post(`/v1/latches/${pair.latchId}/messages`, {
		data: { body: "届かない", client_id: "c-b-1" },
		headers: auth(pair.b),
	});
	expect(send.status()).toBe(400);

	// 退会者の意思は消えている(開発用の観測で見えない)
	const events = await request.get(
		`/v1/dev/match-events?intent_id=${pair.x.id}&limit=50`,
		{ headers: auth(pair.b) },
	);
	expect(((await events.json()) as { items: unknown[] }).items).toHaveLength(0);

	// 同じIdPのアカウントで入り直すと未登録として扱われる
	const again = await request.post("/v1/auth/token", {
		data: { provider: "google", idp_token: await signIdpToken(pair.a.subject) },
	});
	expect(
		((await again.json()) as { registration_required: boolean })
			.registration_required,
	).toBe(true);

	// 後片付け: 相手の意思を消す
	const del = await request.delete(`/v1/intents/${pair.y.id}`, {
		headers: auth(pair.b),
	});
	expect(del.status()).toBe(204);
});
