import { describe, expect, it } from "vitest";
import { k6Invocation } from "./k6run.mjs";

const BASE = "https://latch-example.someone.example.com";

describe("k6Invocation", () => {
	it("宛先と通行証は子の環境変数で渡し、k6の引数(プロセスの一覧に見える)には入れない", () => {
		const env = {
			PATH: "/usr/bin",
			LATCH_LOAD_BASE_URL: `${BASE}/`,
			LATCH_ACCESS_CLIENT_ID: "id-fake-123",
			LATCH_ACCESS_CLIENT_SECRET: "secret-fake-456",
		};
		const r = k6Invocation({
			env,
			scenario: "s.js",
			k6Args: ["-e", "RUN_ID=202610221530"],
		});
		expect(r.args).toEqual(["run", "-e", "RUN_ID=202610221530", "s.js"]);
		const joined = r.args.join(" ");
		expect(joined).not.toContain("id-fake-123");
		expect(joined).not.toContain("secret-fake-456");
		expect(joined).not.toContain("latch-example");
		expect(r.childEnv).toMatchObject({
			PATH: "/usr/bin",
			LATCH_LOAD_BASE_URL: BASE,
			LATCH_ACCESS_CLIENT_ID: "id-fake-123",
			LATCH_ACCESS_CLIENT_SECRET: "secret-fake-456",
		});
		expect(r.base).toBe(BASE);
		expect(r.secrets).toEqual(["id-fake-123", "secret-fake-456"]);
	});

	it("通行証が片方だけなら子の環境から両方を外し、伏せる値も無い", () => {
		const r = k6Invocation({
			env: { LATCH_LOAD_BASE_URL: BASE, LATCH_ACCESS_CLIENT_ID: "id-x" },
			scenario: "s.js",
			k6Args: [],
		});
		expect(r.childEnv.LATCH_ACCESS_CLIENT_ID).toBeUndefined();
		expect(r.childEnv.LATCH_ACCESS_CLIENT_SECRET).toBeUndefined();
		expect(r.secrets).toEqual([]);
	});

	it("宛先が無ければbaseは空", () => {
		expect(k6Invocation({ env: {}, scenario: "s.js", k6Args: [] }).base).toBe(
			"",
		);
	});
});
