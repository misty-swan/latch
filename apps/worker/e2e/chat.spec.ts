/**
 * チャットのE2E(APIレベル・docs/02 §4の#25・F6aのゲート)。
 * 成立した1対1のつながりLATCHで、WebSocketとRESTの双方から送受信し、記録が残ることと、
 * 表示から消した後の相手側が読み取り専用で残ることを実プロセスで確かめる(F6a設計)。
 * 配置はlatches.spec.tsの1対1つながりIntentの成立と同じ(新規ユーザー・各testの前に
 * scripts/clean-e2e-data.mjs・最後にIntentをDELETE)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	type ChatSocket,
	connectChat,
	createIntent,
	nextFrame,
	type RegisteredUser,
	registerUser,
	respond,
	waitFor,
	waitForLatch,
} from "./helpers";

const auth = (user: RegisteredUser): Record<string, string> => ({
	authorization: `Bearer ${user.access_token}`,
});

interface MessageDTO {
	id: string;
	user_id: string;
	body: string;
	client_id: string | null;
}

interface ListedLatch {
	id: string;
	unread_count: number;
	last_message: { body: string; user_id: string } | null;
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
	const topic = "夜に静かに読書の感想を話せる仲間を探しています";
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
	const a = await registerUser(request, "E2EチャットA");
	const x = await make(a);
	await waitForEvaluation(request, a, x.id);
	const b = await registerUser(request, "E2EチャットB");
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

const cleanup = async (
	request: APIRequestContext,
	pair: Awaited<ReturnType<typeof matchPair>>,
): Promise<void> => {
	for (const [user, intent] of [
		[pair.a, pair.x],
		[pair.b, pair.y],
	] as const) {
		const res = await request.delete(`/v1/intents/${intent.id}`, {
			headers: auth(user),
		});
		expect(res.status(), "DELETE /v1/intents/{id}").toBe(204);
	}
};

test("#25 成立LATCHでメッセージを双方向に送受信し、記録が残る", async ({
	request,
	baseURL,
}) => {
	const pair = await matchPair(request);
	const sockets: ChatSocket[] = [];
	try {
		const sa = await connectChat(
			request,
			baseURL as string,
			pair.a.access_token,
			pair.latchId,
		);
		sockets.push(sa);
		const sb = await connectChat(
			request,
			baseURL as string,
			pair.b.access_token,
			pair.latchId,
		);
		sockets.push(sb);

		// AがWSで送ると、Bに届き、Aの接続にだけclient_idが付く
		sa.send({ type: "message", body: "こんにちは", client_id: "c-a-1" });
		const toB = await nextFrame(sb, "message");
		expect(toB.body).toBe("こんにちは");
		expect(toB.user_id).toBe(pair.a.user.id);
		expect(toB.client_id).toBeNull();
		const echo = await nextFrame(sa, "message");
		expect(echo.client_id).toBe("c-a-1");

		// BがRESTで送ると、AにWSで届く
		const postRes = await request.post(`/v1/latches/${pair.latchId}/messages`, {
			data: { body: "はじめまして", client_id: "c-b-1" },
			headers: auth(pair.b),
		});
		expect(postRes.status()).toBe(201);
		const toA = await nextFrame(sa, "message");
		expect(toA.body).toBe("はじめまして");
		expect(toA.user_id).toBe(pair.b.user.id);

		// 履歴はID昇順で2件・送り手はA→B
		const histRes = await request.get(`/v1/latches/${pair.latchId}/messages`, {
			headers: auth(pair.a),
		});
		expect(histRes.status()).toBe(200);
		const { items } = (await histRes.json()) as { items: MessageDTO[] };
		expect(items.map((m) => m.body)).toEqual(["こんにちは", "はじめまして"]);
		expect(items.map((m) => m.user_id)).toEqual([
			pair.a.user.id,
			pair.b.user.id,
		]);
		expect(items[0].id < items[1].id).toBe(true);

		// Aが既読にするとunread_count=0・Bの一覧のlast_messageはB
		const readRes = await request.post(`/v1/latches/${pair.latchId}/read`, {
			data: { last_read_message_id: items[1].id },
			headers: auth(pair.a),
		});
		expect(readRes.status()).toBe(204);
		const listOf = async (user: RegisteredUser): Promise<ListedLatch> => {
			const res = await request.get("/v1/latches?type=matched", {
				headers: auth(user),
			});
			expect(res.status()).toBe(200);
			const body = (await res.json()) as { items: ListedLatch[] };
			return body.items.find((l) => l.id === pair.latchId) as ListedLatch;
		};
		expect((await listOf(pair.a)).unread_count).toBe(0);
		const bView = await listOf(pair.b);
		expect(bView.last_message?.body).toBe("はじめまして");
		expect(bView.last_message?.user_id).toBe(pair.b.user.id);
	} finally {
		for (const s of sockets) {
			s.close();
		}
	}
	await cleanup(request, pair);
});

test("表示から消すと相手側は読み取り専用で残る", async ({
	request,
	baseURL,
}) => {
	const pair = await matchPair(request);
	const sockets: ChatSocket[] = [];
	try {
		const sb = await connectChat(
			request,
			baseURL as string,
			pair.b.access_token,
			pair.latchId,
		);
		sockets.push(sb);
		// Aの古いチケット(未使用)を先に発行しておく
		const ticketRes = await request.post("/v1/ws-ticket", {
			data: { scope: "chat", latch_id: pair.latchId },
			headers: auth(pair.a),
		});
		expect(ticketRes.status()).toBe(200);
		const { ticket } = (await ticketRes.json()) as { ticket: string };

		const delRes = await request.delete(`/v1/latches/${pair.latchId}`, {
			headers: auth(pair.a),
		});
		expect(delRes.status()).toBe(204);
		await nextFrame(sb, "closed");

		// Bは送れないが履歴は読める
		const sendRes = await request.post(`/v1/latches/${pair.latchId}/messages`, {
			data: { body: "届きますか", client_id: "c-b-2" },
			headers: auth(pair.b),
		});
		expect(sendRes.status()).toBe(400);
		const err = (await sendRes.json()) as {
			error: { details: { reasons: string[] } };
		};
		expect(err.error.details.reasons).toEqual(["read_only"]);
		const histRes = await request.get(`/v1/latches/${pair.latchId}/messages`, {
			headers: auth(pair.b),
		});
		expect(histRes.status()).toBe(200);

		// Aには404・Aの古いチケットでの接続は開かない
		const getRes = await request.get(`/v1/latches/${pair.latchId}`, {
			headers: auth(pair.a),
		});
		expect(getRes.status()).toBe(404);
		const url = `${(baseURL as string).replace(/^http/, "ws")}/v1/latches/${pair.latchId}/ws?ticket=${ticket}`;
		const ws = new WebSocket(url);
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
		});
		await new Promise<void>((resolve) => {
			ws.addEventListener("close", () => resolve(), { once: true });
		});
		expect(opened).toBe(false);
		// 401はHTTPで確認する(同じチケットはWS試行で消費済みでも401)
		const probe = await request.get(
			`/v1/latches/${pair.latchId}/ws?ticket=${ticket}`,
			{ headers: { upgrade: "websocket", connection: "Upgrade" } },
		);
		expect(probe.status()).toBe(401);
	} finally {
		for (const s of sockets) {
			s.close();
		}
	}
	await cleanup(request, pair);
});
