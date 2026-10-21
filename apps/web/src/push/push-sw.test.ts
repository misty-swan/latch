// @vitest-environment node
/**
 * public/push-sw.js(Service Workerのプッシュ処理・設計書 §3.2)の単体試験。
 * ファイルをそのまま読み・偽のselfへ評価して通知の題名・本文と押したときの遷移先を確かめる
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type LatchPush = {
	notificationFrom(data: unknown): { title: string; body: string };
	openNotices(clients: unknown): Promise<void>;
};

const DEFAULT_BODY = "提案が届いています。詳細はアプリでご確認ください。";

const load = () => {
	const src = readFileSync(
		new URL("../../public/push-sw.js", import.meta.url),
		"utf8",
	);
	const listeners: Record<string, (event: unknown) => void> = {};
	const fakeSelf: Record<string, unknown> = {
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			listeners[type] = fn;
		},
	};
	new Function("self", src)(fakeSelf);
	return { latchPush: fakeSelf.latchPush as LatchPush, listeners, fakeSelf };
};

describe("push-sw.js", () => {
	it("pushとnotificationclickのリスナーを登録する", () => {
		const { listeners } = load();
		expect(Object.keys(listeners).sort()).toEqual([
			"notificationclick",
			"push",
		]);
	});

	it("ペイロードの本文をそのまま出し・題名はLATCH", () => {
		const { latchPush } = load();
		const body = "つながりが成立しました。詳細はアプリでご確認ください。";
		expect(latchPush.notificationFrom({ type: "matched", body })).toEqual({
			title: "LATCH",
			body,
		});
	});

	it("壊れた入力では既定の本文", () => {
		const { latchPush } = load();
		for (const input of [
			null,
			undefined,
			"x",
			1,
			{},
			{ body: "" },
			{ body: 3 },
		]) {
			expect(latchPush.notificationFrom(input)).toEqual({
				title: "LATCH",
				body: DEFAULT_BODY,
			});
		}
	});

	it("pushで通知を出す(IDやdataを載せない)", async () => {
		const { listeners, fakeSelf } = load();
		const showNotification = vi.fn(async () => undefined);
		fakeSelf.registration = { showNotification };
		let waited: Promise<unknown> | undefined;
		listeners.push?.({
			data: { json: () => ({ type: "proposal", body: "本文" }) },
			waitUntil: (p: Promise<unknown>) => {
				waited = p;
			},
		});
		await waited;
		expect(showNotification).toHaveBeenCalledWith("LATCH", { body: "本文" });

		listeners.push?.({
			data: {
				json: () => {
					throw new Error("bad json");
				},
			},
			waitUntil: (p: Promise<unknown>) => {
				waited = p;
			},
		});
		await waited;
		expect(showNotification).toHaveBeenLastCalledWith("LATCH", {
			body: DEFAULT_BODY,
		});
	});

	it("openNoticesは既存の窓があれば/noticesへ移して前に出す", async () => {
		const { latchPush } = load();
		const client = {
			navigate: vi.fn(async () => client),
			focus: vi.fn(async () => client),
		};
		const clients = {
			matchAll: vi.fn(async () => [client]),
			openWindow: vi.fn(async () => null),
		};
		await latchPush.openNotices(clients);
		expect(client.focus.mock.invocationCallOrder[0]).toBeLessThan(
			client.navigate.mock.invocationCallOrder[0] ?? 0,
		);
		expect(clients.matchAll).toHaveBeenCalledWith({
			type: "window",
			includeUncontrolled: true,
		});
		expect(client.navigate).toHaveBeenCalledWith("/notices");
		expect(client.focus).toHaveBeenCalled();
		expect(clients.openWindow).not.toHaveBeenCalled();
	});

	it("openNoticesはnavigateが失敗したら/noticesを新しく開く", async () => {
		const { latchPush } = load();
		const client = {
			navigate: vi.fn(async () => {
				throw new TypeError("not controlled");
			}),
			focus: vi.fn(async () => client),
		};
		const clients = {
			matchAll: vi.fn(async () => [client]),
			openWindow: vi.fn(async () => null),
		};
		await latchPush.openNotices(clients);
		expect(clients.openWindow).toHaveBeenCalledWith("/notices");
	});

	it("openNoticesはnavigateがnullなら/noticesを新しく開く", async () => {
		const { latchPush } = load();
		const client = {
			navigate: vi.fn(async () => null),
			focus: vi.fn(async () => client),
		};
		const clients = {
			matchAll: vi.fn(async () => [client]),
			openWindow: vi.fn(async () => null),
		};
		await latchPush.openNotices(clients);
		expect(clients.openWindow).toHaveBeenCalledWith("/notices");
	});

	it("openNoticesは窓が無ければ/noticesを新しく開く", async () => {
		const { latchPush } = load();
		const clients = {
			matchAll: vi.fn(async () => []),
			openWindow: vi.fn(async () => null),
		};
		await latchPush.openNotices(clients);
		expect(clients.openWindow).toHaveBeenCalledWith("/notices");
	});

	it("notificationclickで通知を閉じて/noticesを開く", async () => {
		const { listeners, fakeSelf } = load();
		const clients = {
			matchAll: vi.fn(async () => []),
			openWindow: vi.fn(async () => null),
		};
		fakeSelf.clients = clients;
		const close = vi.fn();
		let waited: Promise<unknown> | undefined;
		listeners.notificationclick?.({
			notification: { close },
			waitUntil: (p: Promise<unknown>) => {
				waited = p;
			},
		});
		await waited;
		expect(close).toHaveBeenCalled();
		expect(clients.openWindow).toHaveBeenCalledWith("/notices");
	});
});
