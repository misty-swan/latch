import { describe, expect, it } from "vitest";
import {
	chatMaxDurationSec,
	chatPlan,
	chatSetupTimeoutSec,
	chatWsUrl,
	clientId,
	deliveryMs,
	messageBody,
} from "./chat.mjs";

describe("chatPlan", () => {
	it("倍率1は50組・300秒", () => {
		expect(chatPlan(1)).toEqual({ pairs: 50, holdSec: 300 });
	});
	it("倍率0.1は5組・30秒", () => {
		expect(chatPlan(0.1)).toEqual({ pairs: 5, holdSec: 30 });
	});
	it("小さすぎる倍率でも最低1組・1秒", () => {
		expect(chatPlan(0.001)).toEqual({ pairs: 1, holdSec: 1 });
	});
});

describe("chatSetupTimeoutSec・chatMaxDurationSec", () => {
	it("setupは提案待ち+300秒+組数×6秒", () => {
		expect(chatSetupTimeoutSec(50, 60)).toBe(60 + 300 + 300);
		expect(chatSetupTimeoutSec(5, 900)).toBe(900 + 300 + 30);
	});
	it("本体は接続を保つ秒数+60秒", () => {
		expect(chatMaxDurationSec(300)).toBe(360);
	});
});

describe("chatWsUrl", () => {
	it("httpsはwss・httpはwsにする", () => {
		expect(chatWsUrl("https://example.test/", "L1", "a.b")).toBe(
			"wss://example.test/v1/latches/L1/ws?ticket=a.b",
		);
		expect(chatWsUrl("http://127.0.0.1:8787", "L1", "t")).toBe(
			"ws://127.0.0.1:8787/v1/latches/L1/ws?ticket=t",
		);
	});
});

describe("messageBody・clientId", () => {
	it("本文はt=<時刻>・client_idは<VU>-<連番>", () => {
		expect(messageBody(1_761_000_000_000)).toBe("t=1761000000000");
		expect(clientId(3, 12)).toBe("3-12");
	});
});

describe("deliveryMs", () => {
	const frame = (f) => JSON.stringify(f);
	it("相手の発言(client_idがnull)は到着までのミリ秒", () => {
		const raw = frame({
			type: "message",
			id: "x",
			user_id: "u",
			body: "t=1000",
			created_at: "",
			client_id: null,
		});
		expect(deliveryMs(raw, 1_250)).toBe(250);
	});
	it("自分の送信の折り返し(client_idあり)は除く", () => {
		const raw = frame({ type: "message", body: "t=1000", client_id: "1-0" });
		expect(deliveryMs(raw, 1_250)).toBeNull();
	});
	it("message以外・本文の形が違う・JSONでない(pong)は除く", () => {
		expect(deliveryMs(frame({ type: "closed" }), 1)).toBeNull();
		expect(
			deliveryMs(
				frame({ type: "error", code: "internal", client_id: null }),
				1,
			),
		).toBeNull();
		expect(
			deliveryMs(frame({ type: "message", body: "hello", client_id: null }), 1),
		).toBeNull();
		expect(deliveryMs("pong", 1)).toBeNull();
		expect(deliveryMs("null", 1)).toBeNull();
	});
});
