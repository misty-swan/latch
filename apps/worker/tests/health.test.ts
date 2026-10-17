import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";

it('GET /healthz が200と {"status":"ok"} を返す', async () => {
	const res = await SELF.fetch("https://localhost/healthz");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ status: "ok" });
});

it("D1 binding(DB)に接続してクエリできる", async () => {
	const row = await env.DB.prepare("select 1 as v").first<{ v: number }>();
	expect(row).toEqual({ v: 1 });
});

it("queue・scheduledハンドラがdefault exportされている", () => {
	expect(typeof worker.queue).toBe("function");
	expect(typeof worker.scheduled).toBe("function");
});
