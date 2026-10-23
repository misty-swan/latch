import { describe, expect, it } from "vitest";
import { createLineRedactor, redact } from "./redact.mjs";

const BASE = "https://latch-example.someone.example.com";

describe("redact", () => {
	it("k6のWARN行の宛先のURLを伏せる", () => {
		const line = `time="2026-10-22T04:31:00Z" level=warning msg="Request Failed" error="Post \\"${BASE}/v1/intents\\": dial tcp: lookup latch-example.someone.example.com: no such host"`;
		const out = redact(line, `${BASE}/`);
		expect(out).not.toContain("latch-example.someone.example.com");
		expect(out).toContain(
			'error="Post \\"<url伏せ>\\": dial tcp: lookup <url伏せ>',
		);
	});
	it("wssのURLも伏せる", () => {
		expect(
			redact(
				`connect wss://latch-example.someone.example.com/v1/latches/x/ws?ticket=t`,
				BASE,
			),
		).toBe("connect <url伏せ>");
	});
	it("宛先の指定が無くてもworkers.devのURLは伏せる(redactUrlsと同じ規則)", () => {
		expect(redact("GET https://a-b.c.workers.dev/healthz ok")).toBe(
			"GET <url伏せ> ok",
		);
	});
	it("関係の無い行はそのまま", () => {
		expect(redact("✓ 'p(95)<500' p(95)=259.22ms", BASE)).toBe(
			"✓ 'p(95)<500' p(95)=259.22ms",
		);
	});
});

describe("redact(Accessの通行証)", () => {
	it("通行証の2つの値を伏せる", () => {
		const out = redact(
			"hdr id=fake-id-123.access secret=fake-secret-456 end",
			BASE,
			["fake-id-123.access", "fake-secret-456"],
		);
		expect(out).toBe("hdr id=<伏せ> secret=<伏せ> end");
	});
	it("空の値は無視する(全文字が伏せ字になるのを防ぐ)", () => {
		expect(redact("abc", BASE, ["", undefined])).toBe("abc");
	});
	it("行の処理にも秘密の値を渡せる", () => {
		const out = [];
		const r = createLineRedactor(BASE, (s) => out.push(s), ["fake-secret-456"]);
		r.push("x fake-sec");
		r.push("ret-456 y\n");
		r.end();
		expect(out.join("")).toBe("x <伏せ> y\n");
	});
});

describe("createLineRedactor", () => {
	it("chunkの境目で割れたホスト名も伏せる", () => {
		const out = [];
		const r = createLineRedactor(BASE, (s) => out.push(s));
		r.push("WARN Post https://latch-exam");
		r.push("ple.someone.example.com/v1/x\nrunning\r");
		r.push("tail");
		r.end();
		const all = out.join("");
		expect(all).not.toContain("someone.example.com");
		expect(all).toBe("WARN Post <url伏せ>\nrunning\rtail");
	});
});
