/**
 * 正解データの自己申告のE2E(APIレベル・docs/01 §14・docs/05 §3.3・F9)。
 * 成立した1対1のつながりLATCHで、成立から7日の前は受け付けず、7日を過ぎると
 * 一覧のfeedback_dueに現れ、申告・スキップ・重複の扱いが実プロセスで成り立つことを確かめる。
 * 成立時刻はdev専用のbackdate(matched_at)で7日前へずらす。
 * 配置はchat.spec.tsと同じ(新規ユーザー・各testの前にscripts/clean-e2e-data.mjs・最後にIntentをDELETE)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	createIntent,
	type RegisteredUser,
	registerUser,
	respond,
	waitFor,
	waitForLatch,
} from "./helpers";

const auth = (user: RegisteredUser): Record<string, string> => ({
	authorization: `Bearer ${user.access_token}`,
});

interface ListedLatch {
	id: string;
	feedback_due?: string | null;
}

test.setTimeout(180_000);

test.beforeEach(() => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: path.join(import.meta.dirname, ".."),
		stdio: "ignore",
	});
});

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
	const topic = "週末に近所で一緒に写真を撮り歩ける仲間を探しています";
	const geo = {
		center: { lat: 34.7, lng: 131.5 },
		radius_m: 1_000,
	};
	const make = (user: RegisteredUser) =>
		createIntent(request, user.access_token, {
			raw_text: topic,
			form: "connection",
			topic,
			geo,
		});
	const a = await registerUser(request, "E2E申告A");
	const x = await make(a);
	await waitForEvaluation(request, a, x.id);
	const b = await registerUser(request, "E2E申告B");
	const y = await make(b);
	await waitForEvaluation(request, b, y.id);
	const latch = await waitForLatch(
		request,
		a.access_token,
		x.id,
		(i) => i.intent_ids.includes(x.id) && i.intent_ids.includes(y.id),
	);
	await respond(request, a.access_token, latch.id, "yes");
	await respond(request, b.access_token, latch.id, "yes");
	return { a, b, x, y, latchId: latch.id };
};

test("つながりの品質の申告は成立から7日で受け付け、1人1回だけ記録する", async ({
	request,
}) => {
	const pair = await matchPair(request);
	const post = (user: RegisteredUser, data: unknown) =>
		request.post(`/v1/latches/${pair.latchId}/feedback`, {
			data,
			headers: auth(user),
		});
	const reasonsOf = async (
		res: Awaited<ReturnType<typeof post>>,
	): Promise<unknown> =>
		((await res.json()) as { error: { details: { reasons?: string[] } } }).error
			.details.reasons;
	const dueOf = async (user: RegisteredUser) => {
		const res = await request.get("/v1/latches?type=matched", {
			headers: auth(user),
		});
		expect(res.status()).toBe(200);
		const { items } = (await res.json()) as { items: ListedLatch[] };
		return items.find((l) => l.id === pair.latchId)?.feedback_due;
	};

	// 成立直後は受け付けない
	expect(await dueOf(pair.a)).toBeNull();
	const early = await post(pair.a, {
		kind: "connection_quality",
		value: { score: 4 },
	});
	expect(early.status()).toBe(400);
	expect(await reasonsOf(early)).toEqual(["invalid_status"]);

	// 成立を8日前へずらすと、両者の一覧に受付中として現れる
	const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
	const back = await request.post(`/v1/dev/latches/${pair.latchId}/backdate`, {
		data: { matched_at: eightDaysAgo.toISOString() },
		headers: auth(pair.a),
	});
	expect(back.status()).toBe(200);
	expect(await dueOf(pair.a)).toBe("connection_quality");
	expect(await dueOf(pair.b)).toBe("connection_quality");

	// 形式と合わない種別は断る
	const mismatch = await post(pair.a, {
		kind: "attendance",
		value: { attended: true },
	});
	expect(mismatch.status()).toBe(400);
	expect(await reasonsOf(mismatch)).toEqual(["kind_mismatch"]);

	// Aは4を申告・Bはスキップ。どちらも以後はたずねない
	const answered = await post(pair.a, {
		kind: "connection_quality",
		value: { score: 4 },
	});
	expect(answered.status()).toBe(200);
	expect(((await answered.json()) as ListedLatch).feedback_due).toBeNull();
	const skipped = await post(pair.b, {
		kind: "connection_quality",
		value: { score: null },
	});
	expect(skipped.status()).toBe(200);
	expect(await dueOf(pair.a)).toBeNull();
	expect(await dueOf(pair.b)).toBeNull();

	// 2回目は断る
	const again = await post(pair.a, {
		kind: "connection_quality",
		value: { score: 1 },
	});
	expect(again.status()).toBe(400);
	expect(await reasonsOf(again)).toEqual(["already_responded"]);

	// 参加しない人は404
	const stranger = await registerUser(request, "E2E申告C");
	const notMember = await post(stranger, {
		kind: "connection_quality",
		value: { score: 3 },
	});
	expect(notMember.status()).toBe(404);

	for (const [user, intent] of [
		[pair.a, pair.x],
		[pair.b, pair.y],
	] as const) {
		const res = await request.delete(`/v1/intents/${intent.id}`, {
			headers: auth(user),
		});
		expect(res.status(), "DELETE /v1/intents/{id}").toBe(204);
	}
});
