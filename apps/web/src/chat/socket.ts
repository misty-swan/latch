// チャットのWebSocket受信(docs/06のチャット・F6b設計書)。送信はRESTで行うため受信専用。
// Reactに依存しない。タイマーとソケット生成は deps から受け取り、試験で差し替える。
import { chatServerFrameSchema, type MessageDTO } from "@latch/shared";
import { ApiError } from "../api/client";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const PING_INTERVAL_MS = 25_000;

export type ChatSocketEvent =
	| { type: "open" }
	| { type: "message"; message: MessageDTO }
	| { type: "closed" }
	| { type: "stopped" };

export type ChatSocketDeps = {
	fetchTicket(latchId: string): Promise<string>;
	createSocket(url: string): WebSocket;
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

export const chatSocketUrl = (
	latchId: string,
	ticket: string,
	location: Pick<Location, "protocol" | "host">,
): string => {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/v1/latches/${encodeURIComponent(latchId)}/ws?ticket=${encodeURIComponent(ticket)}`;
};

export const openChatSocket = (
	latchId: string,
	onEvent: (e: ChatSocketEvent) => void,
	deps: ChatSocketDeps,
): { close(): void } => {
	// ブラウザのタイマーはthisがwindow以外だとIllegal invocationになるため、deps経由のメソッド呼び出しを避けて取り出す
	const { setTimeout, clearTimeout, setInterval, clearInterval } = deps;
	let stopped = false; // close()・closedフレーム・stopped のいずれかで以後何もしない
	let delay = RECONNECT_BASE_MS;
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;

	const stopPing = () => {
		if (pingTimer !== null) clearInterval(pingTimer);
		pingTimer = null;
	};

	const scheduleRetry = () => {
		if (stopped) return;
		const wait = delay;
		delay = Math.min(delay * 2, RECONNECT_MAX_MS);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void connect();
		}, wait);
	};

	const connect = async () => {
		let ticket: string;
		try {
			ticket = await deps.fetchTicket(latchId);
		} catch (e) {
			if (stopped) return;
			if (
				e instanceof ApiError &&
				(e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED")
			) {
				stopped = true;
				onEvent({ type: "stopped" });
				return;
			}
			scheduleRetry();
			return;
		}
		if (stopped) return;
		const ws = deps.createSocket(
			chatSocketUrl(latchId, ticket, window.location),
		);
		socket = ws;
		ws.onopen = () => {
			if (stopped || socket !== ws) return;
			delay = RECONNECT_BASE_MS;
			stopPing();
			pingTimer = setInterval(() => ws.send("ping"), PING_INTERVAL_MS);
			onEvent({ type: "open" });
		};
		ws.onmessage = (ev) => {
			if (stopped || socket !== ws) return;
			if (typeof ev.data !== "string" || ev.data === "pong") return;
			let json: unknown;
			try {
				json = JSON.parse(ev.data);
			} catch {
				return;
			}
			const parsed = chatServerFrameSchema.safeParse(json);
			if (!parsed.success) return;
			const frame = parsed.data;
			if (frame.type === "message") {
				const { type: _type, ...message } = frame;
				onEvent({ type: "message", message });
			} else if (frame.type === "closed") {
				stopped = true;
				stopPing();
				onEvent({ type: "closed" });
			}
			// errorフレームは送信がRESTのため無視する
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = null;
			stopPing();
			scheduleRetry();
		};
	};

	void connect();

	return {
		close() {
			stopped = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			retryTimer = null;
			stopPing();
			const ws = socket;
			socket = null;
			ws?.close();
		},
	};
};
