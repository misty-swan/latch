/**
 * 通知のE2E(APIレベル・docs/02 §4の#16のAPI部分・F7b設計 §6.1・10 §4)。
 * 提案・成立のアプリ内通知とWeb Pushの送出状態(LATCH_PUSH_MODE=stub: 購読あり=sent・
 * なし=no_subscription・muted=muted)、未読数と既読化を、wrangler devの実プロセスで確かめる。
 *
 * 配置はsafety.spec.tsと同じ(新規ユーザー・各testの前にclean-e2e-dataで他specの残置
 * Intentをexpiredへ倒す・離れた地域・最後にIntentをDELETE)。Pushの送出はキュー消費後・
 * 変更系API後のwaitUntilとCronの回収で行われるため、push_stateがpendingを抜けるまで待つ
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	type CreatedIntent,
	createIntent,
	type DevNotification,
	listDevNotifications,
	type RegisteredUser,
	registerUser,
	respond,
	subscribePush,
	waitFor,
	waitForLatch,
} from "./helpers";

const workerDir = path.join(import.meta.dirname, "..");

const auth = (user: RegisteredUser): Record<string, string> => ({
	authorization: `Bearer ${user.access_token}`,
});

/** testごとの地域(半径1km)。safety.spec.ts(緯度36度台)と重ならない緯度38度台に置く */
const site = (n: number) => ({
	center: { lat: 38.0055 + n * 0.1, lng: 131.5055 },
	radius_m: 1_000,
});

const TOPIC = "週末に一緒に山歩きをする仲間を探しています";

test.setTimeout(180_000);

test.beforeEach(() => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: workerDir,
		stdio: "ignore",
	});
});

const create = (
	request: APIRequestContext,
	user: RegisteredUser,
	n: number,
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: TOPIC,
		form: "connection",
		topic: TOPIC,
		geo: site(n),
	});

/** 指定種別の通知がpending以外の状態で現れるまで待って返す */
const settledNotification = async (
	request: APIRequestContext,
	user: RegisteredUser,
	type: string,
): Promise<DevNotification> => {
	let found: DevNotification | undefined;
	await waitFor(
		async () => {
			found = (await listDevNotifications(request, user.access_token)).find(
				(n) => n.type === type && n.push_state !== "pending",
			);
			return found !== undefined;
		},
		60_000,
		500,
	);
	return found as DevNotification;
};

/** GET /v1/notificationsの応答 */
interface NotificationList {
	items: Array<{ id: string; type: string }>;
	unread_count: number;
}

const getNotifications = async (
	request: APIRequestContext,
	user: RegisteredUser,
): Promise<NotificationList> => {
	const res = await request.get("/v1/notifications", { headers: auth(user) });
	expect(res.status(), "GET /v1/notifications").toBe(200);
	return (await res.json()) as NotificationList;
};

const deleteIntent = async (
	request: APIRequestContext,
	user: RegisteredUser,
	intentId: string,
): Promise<void> => {
	const res = await request.delete(`/v1/intents/${intentId}`, {
		headers: auth(user),
	});
	expect(res.status(), `DELETE /v1/intents/${intentId}`).toBe(204);
};

/** Aを先に作って評価を待たず作成し、Bの作成後にペアの提案を待つ */
const setup = async (
	request: APIRequestContext,
	label: string,
	n: number,
	beforeA?: (a: RegisteredUser) => Promise<void>,
) => {
	const a = await registerUser(request, `E2E${label}A`);
	const b = await registerUser(request, `E2E${label}B`);
	await beforeA?.(a);
	const x = await create(request, a, n);
	const y = await create(request, b, n);
	return { a, b, x, y };
};

test("#16 提案のアプリ内通知とPush送出状態(購読あり=sent・なし=no_subscription)", async ({
	request,
}) => {
	const { a, b, x, y } = await setup(request, "通知1", 1, async (a) => {
		await subscribePush(
			request,
			a.access_token,
			`https://fcm.googleapis.com/fcm/send/e2e-${a.user.id}`,
		);
	});
	const latch = await waitForLatch(request, a.access_token, x.id, (l) =>
		l.intent_ids.includes(y.id),
	);
	expect(latch.status).toBe("proposed");

	const na = await settledNotification(request, a, "proposal");
	const nb = await settledNotification(request, b, "proposal");
	expect(na.latch_id).toBe(latch.id);
	expect(nb.latch_id).toBe(latch.id);
	expect(na.push_state).toBe("sent");
	expect(nb.push_state).toBe("no_subscription");

	for (const u of [a, b]) {
		const list = await getNotifications(request, u);
		expect(list.items.some((i) => i.type === "proposal")).toBe(true);
		expect(list.unread_count).toBeGreaterThanOrEqual(1);
	}

	await deleteIntent(request, a, x.id);
	await deleteIntent(request, b, y.id);
});

test("#16 通知を受け取らない意思(muted)では行は作られPushはmutedになる", async ({
	request,
}) => {
	const a = await registerUser(request, "E2E通知2A");
	const b = await registerUser(request, "E2E通知2B");
	await subscribePush(
		request,
		a.access_token,
		`https://fcm.googleapis.com/fcm/send/e2e-${a.user.id}`,
	);
	const x = await create(request, a, 2);
	// 先の側の評価(ベクトルのupsert)が済んでからBを作る(検索に先の側を確実に含める)
	await waitFor(
		async () => {
			const res = await request.get(
				`/v1/dev/match-events?intent_id=${x.id}&limit=50`,
				{ headers: auth(a) },
			);
			const { items } = (await res.json()) as {
				items: Array<{ event_type: string; status: string }>;
			};
			return items.some(
				(e) =>
					e.event_type === "embedding_completed" && e.status === "processed",
			);
		},
		60_000,
		500,
	);
	const patch = await request.patch(`/v1/intents/${x.id}`, {
		data: { notification_level: "muted" },
		headers: auth(a),
	});
	expect(patch.status(), "PATCH /v1/intents/{id}").toBe(200);
	const y = await create(request, b, 2);

	const latch = await waitForLatch(request, a.access_token, x.id, (l) =>
		l.intent_ids.includes(y.id),
	);
	expect(latch.status).toBe("proposed");
	const na = await settledNotification(request, a, "proposal");
	expect(na.push_state).toBe("muted");
	expect(na.latch_id).toBe(latch.id);
	// mutedでもLATCHは進められる
	const answered = await respond(request, a.access_token, latch.id, "yes");
	expect(answered.status).toBe("partial_accept");

	await deleteIntent(request, a, x.id);
	await deleteIntent(request, b, y.id);
});

test("#16 成立の通知は購読ありでsentになり、既読化で未読数が0になる", async ({
	request,
}) => {
	const { a, b, x, y } = await setup(request, "通知3", 3, async (a) => {
		await subscribePush(
			request,
			a.access_token,
			`https://fcm.googleapis.com/fcm/send/e2e-${a.user.id}`,
		);
	});
	const latch = await waitForLatch(request, a.access_token, x.id, (l) =>
		l.intent_ids.includes(y.id),
	);
	await respond(request, a.access_token, latch.id, "yes");
	const done = await respond(request, b.access_token, latch.id, "yes");
	expect(done.status).toBe("matched");

	const matchedA = await settledNotification(request, a, "matched");
	expect(matchedA.push_state).toBe("sent");
	expect(matchedA.latch_id).toBe(latch.id);
	const matchedB = await settledNotification(request, b, "matched");
	expect(matchedB.push_state).toBe("no_subscription");

	for (const u of [a, b]) {
		const before = await getNotifications(request, u);
		expect(before.items.some((i) => i.type === "matched")).toBe(true);
		const upTo = before.items[0]?.id as string;
		const read = await request.post("/v1/notifications/read", {
			data: { up_to_id: upTo },
			headers: auth(u),
		});
		expect(read.status(), "POST /v1/notifications/read").toBe(204);
		expect((await getNotifications(request, u)).unread_count).toBe(0);
	}

	await deleteIntent(request, a, x.id);
	await deleteIntent(request, b, y.id);
});
