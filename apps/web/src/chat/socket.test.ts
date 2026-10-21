import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
	type ChatSocketEvent,
	chatSocketUrl,
	openChatSocket,
	PING_INTERVAL_MS,
	RECONNECT_MAX_MS,
} from "./socket";

class FakeSocket {
	static all: FakeSocket[] = [];
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeSocket.all.push(this);
	}
	send(d: string) {
		this.sent.push(d);
	}
	close() {
		this.closed = true;
	}
	open() {
		this.onopen?.();
	}
	recv(d: unknown) {
		this.onmessage?.({ data: typeof d === "string" ? d : JSON.stringify(d) });
	}
	drop() {
		this.onclose?.();
	}
}

const msgFrame = {
	type: "message",
	id: "m1",
	user_id: "u1",
	body: "こんにちは",
	created_at: "2026-10-21T00:00:00.000Z",
	client_id: null,
};

const setup = (fetchTicket = vi.fn().mockResolvedValue("tk")) => {
	const events: ChatSocketEvent[] = [];
	const handle = openChatSocket("L1", (e) => events.push(e), {
		fetchTicket,
		createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
	});
	return { events, handle, fetchTicket };
};
const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("chatSocketUrl", () => {
	it("httpsならwssになる", () => {
		expect(
			chatSocketUrl("L 1", "a b", { protocol: "https:", host: "x.test" }),
		).toBe("wss://x.test/v1/latches/L%201/ws?ticket=a%20b");
		expect(
			chatSocketUrl("L1", "t", { protocol: "http:", host: "localhost:1" }),
		).toBe("ws://localhost:1/v1/latches/L1/ws?ticket=t");
	});
});

describe("openChatSocket", () => {
	it("ticket付きで接続し、openを通知する", async () => {
		const { events } = setup();
		await flush();
		expect(last().url).toContain("/v1/latches/L1/ws?ticket=tk");
		last().open();
		expect(events).toEqual([{ type: "open" }]);
	});

	it("messageフレームを通知し、pong・不正JSON・errorは無視する", async () => {
		const { events } = setup();
		await flush();
		last().open();
		last().recv("pong");
		last().recv("{bad");
		last().recv({ type: "error", code: "VALIDATION_FAILED", client_id: null });
		last().recv({ type: "nope" });
		last().recv(msgFrame);
		const { type: _t, ...message } = msgFrame;
		expect(events).toEqual([{ type: "open" }, { type: "message", message }]);
	});

	it("切断が続くと1秒・2秒・4秒待ち、接続成功後は1秒に戻る", async () => {
		setup();
		await flush();
		for (const wait of [1000, 2000, 4000]) {
			const n = FakeSocket.all.length;
			last().drop();
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(FakeSocket.all.length).toBe(n);
			await vi.advanceTimersByTimeAsync(1);
			expect(FakeSocket.all.length).toBe(n + 1);
		}
		last().open();
		const n = FakeSocket.all.length;
		last().drop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(FakeSocket.all.length).toBe(n + 1);
	});

	it("待ち時間は30秒で頭打ち", async () => {
		setup();
		await flush();
		for (let i = 0; i < 8; i++) {
			last().drop();
			await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
		}
		const n = FakeSocket.all.length;
		last().drop();
		await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
		expect(FakeSocket.all.length).toBe(n + 1);
	});

	it("25秒ごとにpingを送る", async () => {
		setup();
		await flush();
		last().open();
		await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
		expect(last().sent).toEqual(["ping", "ping"]);
	});

	it("closedフレームの後は切断されても再接続しない", async () => {
		const { events } = setup();
		await flush();
		last().open();
		last().recv({ type: "closed" });
		last().drop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(events).toEqual([{ type: "open" }, { type: "closed" }]);
		expect(FakeSocket.all.length).toBe(1);
	});

	it("チケット取得がNOT_FOUNDならstoppedで再接続しない", async () => {
		const { events } = setup(
			vi.fn().mockRejectedValue(new ApiError("NOT_FOUND", "x")),
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(events).toEqual([{ type: "stopped" }]);
		expect(FakeSocket.all.length).toBe(0);
	});

	it("チケット取得の通信失敗は待ってやり直す", async () => {
		const fetchTicket = vi
			.fn()
			.mockRejectedValueOnce(new Error("net"))
			.mockResolvedValue("tk");
		setup(fetchTicket);
		await flush();
		expect(FakeSocket.all.length).toBe(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(FakeSocket.all.length).toBe(1);
	});

	it("close()後は再接続もpingもしない", async () => {
		const { events, handle } = setup();
		await flush();
		const s = last();
		s.open();
		handle.close();
		expect(s.closed).toBe(true);
		s.drop();
		s.recv(msgFrame);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(s.sent).toEqual([]);
		expect(FakeSocket.all.length).toBe(1);
		expect(events).toEqual([{ type: "open" }]);
	});

	it("チケット取得中にclose()すると接続しない", async () => {
		const { handle } = setup();
		handle.close();
		await vi.advanceTimersByTimeAsync(5000);
		expect(FakeSocket.all.length).toBe(0);
	});

	it("タイマー関数はthisなしで呼ばれる(ブラウザのIllegal invocation対策)", async () => {
		const guard = <F extends (...a: never[]) => unknown>(f: F): F =>
			function (this: unknown, ...a: Parameters<F>) {
				if (this !== undefined && this !== globalThis) {
					throw new TypeError("Illegal invocation");
				}
				return f(...a);
			} as unknown as F;
		const events: ChatSocketEvent[] = [];
		openChatSocket("L1", (e) => events.push(e), {
			fetchTicket: vi.fn().mockResolvedValue("tk"),
			createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
			setTimeout: guard(setTimeout),
			clearTimeout: guard(clearTimeout),
			setInterval: guard(setInterval),
			clearInterval: guard(clearInterval),
		});
		await flush();
		last().open();
		await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
		expect(last().sent).toEqual(["ping"]);
		last().drop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(FakeSocket.all.length).toBe(2);
	});
});
