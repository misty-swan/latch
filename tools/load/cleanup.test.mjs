import { describe, expect, it } from "vitest";
import {
	call,
	cleanOneSubject,
	cleanupSubjects,
	subjectsWithIntents,
} from "./cleanup.mjs";

describe("cleanupSubjects", () => {
	it("1人が失敗しても残りの利用者を続けて処理し、件数を合計する", async () => {
		const seen = [];
		const errors = [];
		const result = await cleanupSubjects(
			["load-1", "load-2", "load-3"],
			async (subject) => {
				seen.push(subject);
				if (subject === "load-2") {
					throw new Error(
						"通信エラー https://latch-x.example.workers.dev/v1 で失敗",
					);
				}
				return subject === "load-3"
					? { deleted: 1, failed: 1 }
					: { deleted: 2, failed: 0 };
			},
			(message) => errors.push(message),
		);
		expect(seen).toEqual(["load-1", "load-2", "load-3"]);
		expect(result).toEqual({ deleted: 3, failed: 2, failedUsers: 1 });
		// 誤りの文のURLは伏せる
		expect(errors).toEqual(["通信エラー <url伏せ> で失敗"]);
	});
	it("全員成功なら失敗0件", async () => {
		const result = await cleanupSubjects(["load-1"], async () => ({
			deleted: 4,
			failed: 0,
		}));
		expect(result).toEqual({ deleted: 4, failed: 0, failedUsers: 0 });
	});
	it("利用者がいなければ何もしない", async () => {
		expect(
			await cleanupSubjects([], async () => ({ deleted: 9, failed: 9 })),
		).toEqual({
			deleted: 0,
			failed: 0,
			failedUsers: 0,
		});
	});
});

describe("subjectsWithIntents", () => {
	it("load-で始まるsubjectだけを重複なく返す", () => {
		expect(
			subjectsWithIntents([
				{ auth_subject: "load-1" },
				{ auth_subject: "load-1" },
				{ auth_subject: "user-1" },
				{ auth_subject: null },
				{ auth_subject: "load-2" },
			]),
		).toEqual(["load-1", "load-2"]);
	});
});

/** 時間切れ(signalのabort)まで返らないfetch。時間切れの回数を数える */
const hangingFetch = () => {
	const state = { calls: 0 };
	const fn = (_url, init) => {
		state.calls += 1;
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () =>
				reject(init.signal.reason ?? new Error("aborted")),
			);
		});
	};
	return { fn, state };
};

describe("call(Accessの通行証)", () => {
	it("accessが渡されたら2つのヘッダーを付ける", async () => {
		const seen = [];
		const fn = (_url, init) => {
			seen.push(init.headers);
			return Promise.resolve(new Response(null, { status: 204 }));
		};
		await call("https://x.example", "DELETE", "/v1/intents/a", {
			fetchImpl: fn,
			access: {
				"CF-Access-Client-Id": "id-x",
				"CF-Access-Client-Secret": "secret-x",
			},
		});
		expect(seen[0]["CF-Access-Client-Id"]).toBe("id-x");
		expect(seen[0]["CF-Access-Client-Secret"]).toBe("secret-x");
	});
	it("accessが無ければ付けない", async () => {
		const seen = [];
		const fn = (_url, init) => {
			seen.push(init.headers);
			return Promise.resolve(new Response(null, { status: 204 }));
		};
		await call("https://x.example", "GET", "/v1/intents", { fetchImpl: fn });
		expect(Object.keys(seen[0])).not.toContain("CF-Access-Client-Id");
	});
});

describe("call(時間切れとやり直し)", () => {
	it("時間切れの要求は同じ要求を最大3回やり直し、それでもだめなら例外にする", async () => {
		const { fn, state } = hangingFetch();
		await expect(
			call("https://x.example", "DELETE", "/v1/intents/a", {
				fetchImpl: fn,
				timeoutMs: 10,
			}),
		).rejects.toThrow(/時間切れ/);
		// 初回 + やり直し3回
		expect(state.calls).toBe(4);
	});
	it("やり直しで通れば結果を返す", async () => {
		let n = 0;
		const fn = (_url, init) => {
			n += 1;
			if (n < 3) {
				return new Promise((_r, reject) =>
					init.signal.addEventListener("abort", () =>
						reject(init.signal.reason),
					),
				);
			}
			return Promise.resolve(new Response(null, { status: 204 }));
		};
		const r = await call("https://x.example", "DELETE", "/v1/intents/a", {
			fetchImpl: fn,
			timeoutMs: 10,
		});
		expect(r.status).toBe(204);
		expect(n).toBe(3);
	});
});

describe("cleanOneSubject", () => {
	it("削除が時間切れで通らない意思は残して次へ進み、残った件数を返す", async () => {
		const json = (body) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const deleteCalls = [];
		const fn = (url, init) => {
			const path = new URL(url).pathname;
			if (path === "/v1/dev/idp-token")
				return Promise.resolve(json({ idp_token: "t" }));
			if (path === "/v1/auth/token")
				return Promise.resolve(
					json({ registration_required: false, access_token: "a" }),
				);
			if (path === "/v1/intents")
				return Promise.resolve(
					json({ items: [{ id: "slow" }, { id: "ok" }], next_cursor: null }),
				);
			deleteCalls.push(path);
			if (path.endsWith("/slow")) {
				return new Promise((_r, reject) =>
					init.signal.addEventListener("abort", () =>
						reject(init.signal.reason),
					),
				);
			}
			return Promise.resolve(new Response(null, { status: 204 }));
		};
		const errors = [];
		const r = await cleanOneSubject("https://x.example", "load-1", {
			fetchImpl: fn,
			timeoutMs: 10,
			onError: (m) => errors.push(m),
		});
		expect(r).toEqual({ deleted: 1, failed: 1 });
		// slowは4回試して諦め、okは削除される
		expect(deleteCalls.filter((p) => p.endsWith("/slow"))).toHaveLength(4);
		expect(deleteCalls).toContain("/v1/intents/ok");
		expect(errors.join("")).not.toContain("x.example");
	});
});
