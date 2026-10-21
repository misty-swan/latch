/**
 * Web Pushの購読の手順(設計書 §3.1)の単体試験。
 * ブラウザの許可とpushManagerはPushEnvの偽物へ差し替え・APIはfetchのモックで受ける
 * (実際の購読と受信はF8の実機確認で行う・設計書 §5.2)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../auth/session";
import {
	disablePush,
	disablePushQuietly,
	enablePush,
	getPushStatus,
	type PushEnv,
} from "./subscription";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
// base64urlの公開鍵(65バイトの非圧縮点を模した値)
const PUBLIC_KEY = `BA${"A".repeat(85)}`;

type FakeSubscription = {
	endpoint: string;
	toJSON: () => PushSubscriptionJSON;
	unsubscribe: ReturnType<typeof vi.fn>;
};

const makeSubscription = (): FakeSubscription => ({
	endpoint: ENDPOINT,
	toJSON: () => ({
		endpoint: ENDPOINT,
		expirationTime: null,
		keys: { p256dh: "p256dh-key", auth: "auth-key" },
	}),
	unsubscribe: vi.fn(async () => true),
});

/** 呼び出しの順番を1本の配列へ記録する */
let calls: string[];

const makeEnv = (
	options: {
		permission?: NotificationPermission | "unsupported";
		request?: NotificationPermission;
		existing?: FakeSubscription | null;
		created?: FakeSubscription;
		noManager?: boolean;
	} = {},
) => {
	const created = options.created ?? makeSubscription();
	const manager = {
		getSubscription: vi.fn(async () => options.existing ?? null),
		subscribe: vi.fn(async (_opts: PushSubscriptionOptionsInit) => {
			calls.push("subscribe");
			return created;
		}),
	};
	const env: PushEnv = {
		permission: () => options.permission ?? "default",
		requestPermission: vi.fn(async () => {
			calls.push("requestPermission");
			return options.request ?? "granted";
		}),
		pushManager: async () =>
			options.noManager ? null : (manager as unknown as PushManager),
	};
	return { env, manager, created };
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let postStatus: number;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url === "/v1/push/vapid-public-key") {
			return json({ public_key: PUBLIC_KEY });
		}
		if (url === "/v1/push-subscriptions" && method === "POST") {
			return postStatus >= 400
				? json({ error: { code: "INTERNAL", message: "x" } }, postStatus)
				: json({}, postStatus);
		}
		if (url === "/v1/push-subscriptions" && method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		return json({}, 404);
	},
);

const bodyOf = (method: string, url: string): unknown => {
	const call = fetchMock.mock.calls.find(
		([input, init]) => String(input) === url && init?.method === method,
	);
	return call ? JSON.parse(String(call[1]?.body)) : undefined;
};

beforeEach(() => {
	calls = [];
	postStatus = 201;
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
	authSession.clear();
	authSession.setTokens("access-push", null);
});

afterEach(() => {
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("enablePush", () => {
	it("許可→鍵の取得→購読→登録の順に進みonを返す", async () => {
		const { env, manager } = makeEnv();

		expect(await enablePush(env)).toBe("on");
		expect(calls).toEqual([
			"requestPermission",
			"GET /v1/push/vapid-public-key",
			"subscribe",
			"POST /v1/push-subscriptions",
		]);
		const options = manager.subscribe.mock.calls[0]?.[0];
		expect(options?.userVisibleOnly).toBe(true);
		const key = options?.applicationServerKey as Uint8Array;
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(65);
		expect(key[0]).toBe(4);
		expect(bodyOf("POST", "/v1/push-subscriptions")).toEqual({
			endpoint: ENDPOINT,
			keys: { p256dh: "p256dh-key", auth: "auth-key" },
		});
	});

	it("拒否されたらdeniedを返し登録しない", async () => {
		const { env, manager } = makeEnv({ request: "denied" });

		expect(await enablePush(env)).toBe("denied");
		expect(manager.subscribe).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("非対応のブラウザではunsupportedを返し何もしない", async () => {
		const { env } = makeEnv({ permission: "unsupported" });

		expect(await enablePush(env)).toBe("unsupported");
		expect(env.requestPermission).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("登録が500なら作った購読を外してoffを返す", async () => {
		postStatus = 500;
		const { env, created } = makeEnv();

		expect(await enablePush(env)).toBe("off");
		expect(created.unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("getPushStatus", () => {
	it("許可済みで購読があればon・無ければoff", async () => {
		expect(
			await getPushStatus(
				makeEnv({ permission: "granted", existing: makeSubscription() }).env,
			),
		).toBe("on");
		expect(await getPushStatus(makeEnv({ permission: "granted" }).env)).toBe(
			"off",
		);
	});

	it("未決はoff・拒否済みはdenied・非対応はunsupported", async () => {
		expect(await getPushStatus(makeEnv({ permission: "default" }).env)).toBe(
			"off",
		);
		expect(await getPushStatus(makeEnv({ permission: "denied" }).env)).toBe(
			"denied",
		);
		expect(
			await getPushStatus(makeEnv({ permission: "unsupported" }).env),
		).toBe("unsupported");
		expect(
			await getPushStatus(
				makeEnv({ permission: "granted", noManager: true }).env,
			),
		).toBe("unsupported");
	});
});

describe("disablePush", () => {
	it("購読があればDELETEへ{endpoint}を送ってから購読を外す", async () => {
		const existing = makeSubscription();
		existing.unsubscribe.mockImplementation(async () => {
			calls.push("unsubscribe");
			return true;
		});
		const { env } = makeEnv({ permission: "granted", existing });

		await disablePush(env);
		expect(bodyOf("DELETE", "/v1/push-subscriptions")).toEqual({
			endpoint: ENDPOINT,
		});
		expect(calls).toEqual(["DELETE /v1/push-subscriptions", "unsubscribe"]);
	});

	it("購読が無ければ何も送らない", async () => {
		await disablePush(makeEnv({ permission: "granted" }).env);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("disablePushQuietlyは失敗を飲む", async () => {
		const env: PushEnv = {
			permission: () => "granted",
			requestPermission: async () => "granted",
			pushManager: async () => {
				throw new Error("boom");
			},
		};
		await expect(disablePushQuietly(env)).resolves.toBeUndefined();
	});
});
