/**
 * /latches/:id(LatchScreen・F4c設計 §1.2〜§1.4)の単体試験。
 * 状態ごとの表示の振り分け・[参加する]の成立演出・送信失敗時の取り直しと一文・
 * 回答待ちの30秒ごとの取り直し・URLを開いた時点のmatchedでは演出しないことを確かめる
 */

import type { LatchDTO } from "@latch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../../auth/session";
import { appRoutes } from "../../router";
import { createTestQueryClient, withQueryClient } from "../../test/helpers";
import { selectLatchView } from "./LatchScreen";

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO => ({
	id: "L1",
	form: "connection",
	status: "proposed",
	response_deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
	participants_count: 2,
	my_response: null,
	score: 0.87,
	my_intent_id: "i1",
	matched_at: null,
	...over,
});

const matchedLatch = (): LatchDTO =>
	latchOf({
		status: "matched",
		my_response: "yes",
		matched_at: new Date().toISOString(),
		proposal: {
			form: "connection",
			topic: "絵を見せ合う",
			time_window: null,
			region_name: null,
			budget: null,
		} as LatchDTO["proposal"],
		members: [
			{ user_id: "u2", display_name: "相手", bio: null, has_icon: false },
		],
	});

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** GET /v1/latches/L1の応答を順に返す(尽きたら最後のものを繰り返す) */
let getQueue: Array<() => Response>;
/** POSTの応答 */
let postResponse: () => Response;

const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (method === "GET" && url === "/v1/latches/L1") {
			const next = getQueue.length > 1 ? getQueue.shift() : getQueue[0];
			if (!next) throw new Error("GETの応答が未設定");
			return next();
		}
		if (method === "POST" && url.startsWith("/v1/latches/L1/")) {
			return postResponse();
		}
		// 送信成功後の一覧・Intentの無効化による取り直し
		if (
			method === "GET" &&
			(url.startsWith("/v1/intents") || url.startsWith("/v1/latches?"))
		) {
			return jsonResponse(200, { items: [], next_cursor: null });
		}
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);

const getCalls = () =>
	fetchMock.mock.calls.filter(
		([u, i]) =>
			String(u) === "/v1/latches/L1" && (i?.method ?? "GET") === "GET",
	).length;

const setup = (path = "/latches/L1") => {
	const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
	render(withQueryClient(<RouterProvider router={router} />));
	return router;
};

/** 渡したQueryClientで描く(キャッシュの事前投入・既定の再試行の試験用) */
const setupWith = (client: QueryClient, path = "/latches/L1") => {
	const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

/** 動きの待ちを省く(prefers-reduced-motion: reduce) */
const stubReducedMotion = () => {
	vi.stubGlobal("matchMedia", (media: string) => ({
		matches: media.includes("prefers-reduced-motion"),
		media,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	stubReducedMotion();
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
	authSession.setTokens("access-latch", null);
	getQueue = [() => jsonResponse(200, latchOf())];
	postResponse = () => jsonResponse(200, latchOf({ my_response: "yes" }));
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	authSession.clear();
	localStorage.clear();
});

describe("selectLatchView", () => {
	it.each([
		[{ status: "proposed", my_response: null }, "proposal"],
		[{ status: "partial_accept", my_response: null }, "proposal"],
		[{ status: "proposed", my_response: "yes" }, "awaiting"],
		[{ status: "partial_accept", my_response: "yes" }, "awaiting"],
		[{ status: "matched", my_response: "yes" }, "matched"],
		[{ status: "rejected", my_response: "defer" }, "shelved"],
		[{ status: "partial_accept", my_response: "defer" }, "shelved"],
		[{ status: "rejected", my_response: "no" }, "closed"],
		[{ status: "expired", my_response: "yes" }, "closed"],
		[{ status: "cancelled", my_response: "yes" }, "closed"],
		[
			{
				status: "cancelled",
				my_response: "yes",
				proposal: matchedLatch().proposal,
			},
			"ended",
		],
		[
			{
				status: "completed",
				my_response: "yes",
				proposal: matchedLatch().proposal,
			},
			"ended",
		],
	] as Array<[Partial<LatchDTO>, string]>)("%o → %s", (over, expected) => {
		expect(selectLatchView(latchOf(over))).toBe(expected);
	});
});

describe("LatchScreen", () => {
	it.each([
		[latchOf({ status: "proposed", my_response: null }), "参加する"],
		[latchOf({ status: "partial_accept", my_response: null }), "参加する"],
		[
			latchOf({ status: "partial_accept", my_response: "yes" }),
			"回答を取り消す",
		],
		[matchedLatch(), "つながりました。"],
		[
			latchOf({ status: "rejected", my_response: "no" }),
			"この提案は成立しませんでした。",
		],
		[
			latchOf({ status: "expired", my_response: "yes" }),
			"この提案は成立しませんでした。",
		],
		[
			{ ...matchedLatch(), status: "cancelled" as const },
			"このつながりは終了しました。",
		],
	])("状態に応じた表示(%#)", async (latch, text) => {
		getQueue = [() => jsonResponse(200, latch)];
		setup();
		expect(await screen.findByText(text)).toBeTruthy();
	});

	it("終了したつながりの画面からチャットへ行ける", async () => {
		getQueue = [
			() =>
				jsonResponse(200, {
					...matchedLatch(),
					status: "completed" as const,
				}),
		];
		setup();
		expect(
			await screen.findByText("このつながりは終了しました。"),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "チャットを見る" }).getAttribute("href"),
		).toBe("/latches/L1/chat");
	});

	it("deferの本人は見送った画面へ置き換える", async () => {
		getQueue = [
			() =>
				jsonResponse(
					200,
					latchOf({ status: "rejected", my_response: "defer" }),
				),
		];
		const router = setup();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1/shelved"),
		);
	});

	it("404は見つかりませんでした", async () => {
		getQueue = [
			() =>
				jsonResponse(404, {
					error: { code: "NOT_FOUND", message: "not found" },
				}),
		];
		setup();
		expect(
			await screen.findByText("この提案は見つかりませんでした。"),
		).toBeTruthy();
	});

	it("404は本番と同じ既定の再試行でも1回の取得ですぐ見つかりませんでした", async () => {
		getQueue = [
			() =>
				jsonResponse(404, {
					error: { code: "NOT_FOUND", message: "not found" },
				}),
		];
		setupWith(new QueryClient());
		expect(
			await screen.findByText("この提案は見つかりませんでした。"),
		).toBeTruthy();
		expect(getCalls()).toBe(1);
	});

	it("その他の取得失敗は読み込めませんでしたと再読み込み", async () => {
		getQueue = [
			() => jsonResponse(500, { error: { code: "INTERNAL", message: "x" } }),
			() => jsonResponse(200, latchOf()),
		];
		setup();
		expect(await screen.findByText("読み込めませんでした。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));
		expect(await screen.findByText("参加する")).toBeTruthy();
	});

	it("参加するで応答がmatchedなら演出つきのつながりました", async () => {
		postResponse = () => jsonResponse(200, matchedLatch());
		// 送信成功後の無効化による取り直しもサーバーの新しい状態を返す
		getQueue = [
			() => jsonResponse(200, latchOf()),
			() => jsonResponse(200, matchedLatch()),
		];
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(await screen.findByText("つながりました。")).toBeTruthy();
		expect(document.querySelector(".matched.is-fresh")).not.toBeNull();
		const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
		expect(String(post?.[0])).toBe("/v1/latches/L1/response");
		expect(post?.[1]?.body).toBe(JSON.stringify({ response: "yes" }));
	});

	it("参加するでyesだけなら回答待ちになる", async () => {
		getQueue = [
			() => jsonResponse(200, latchOf()),
			() => jsonResponse(200, latchOf({ my_response: "yes" })),
		];
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(await screen.findByText("回答を取り消す")).toBeTruthy();
	});

	it("今回は見送るで見送った画面へ置き換える", async () => {
		postResponse = () =>
			jsonResponse(200, latchOf({ status: "rejected", my_response: "defer" }));
		getQueue = [
			() => jsonResponse(200, latchOf()),
			() =>
				jsonResponse(
					200,
					latchOf({ status: "rejected", my_response: "defer" }),
				),
		];
		const router = setup();
		fireEvent.click(
			await screen.findByRole("button", { name: "今回は見送る" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1/shelved"),
		);
		const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
		expect(post?.[1]?.body).toBe(JSON.stringify({ response: "defer" }));
		expect(
			await screen.findByText(
				"今回の提案は見送りました。あなたの意思は、そのまま預けています。",
			),
		).toBeTruthy();
	});

	it.each([
		[2, ".latch.is-shelving"],
		[3, ".group-wrap.is-shelving"],
	])(
		"今回は見送るで絵に棚へ戻す動きを付ける(%i人)",
		async (count, selector) => {
			getQueue = [
				() => jsonResponse(200, latchOf({ participants_count: count })),
			];
			// 応答を返さず送信中のままにして・動きのクラスを見る
			postResponse = () =>
				new Promise<Response>(() => {}) as unknown as Response;
			setup();
			fireEvent.click(
				await screen.findByRole("button", { name: "今回は見送る" }),
			);
			await waitFor(() =>
				expect(document.querySelector(selector)).not.toBeNull(),
			);
			expect(
				(screen.getByRole("button", { name: "参加する" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		},
	);

	it("参加するで半円を押し込む", async () => {
		postResponse = () => new Promise<Response>(() => {}) as unknown as Response;
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		await waitFor(() =>
			expect(document.querySelector(".latch.is-pressed")).not.toBeNull(),
		);
		expect(document.querySelector(".latch.is-arrived")).toBeNull();
	});

	it("回答を取り消すでretractを送り提案へ戻る", async () => {
		getQueue = [
			() => jsonResponse(200, latchOf({ my_response: "yes" })),
			() => jsonResponse(200, latchOf()),
		];
		postResponse = () => jsonResponse(200, latchOf());
		setup();
		fireEvent.click(
			await screen.findByRole("button", { name: "回答を取り消す" }),
		);
		expect(
			await screen.findByRole("button", { name: "参加する" }),
		).toBeTruthy();
		const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
		expect(String(post?.[0])).toBe("/v1/latches/L1/response/retract");
	});

	it("回答期限切れの400では取り直して知らせる", async () => {
		postResponse = () =>
			jsonResponse(400, {
				error: {
					code: "VALIDATION_FAILED",
					message: "x",
					details: { reasons: ["deadline_passed"] },
				},
			});
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(
			await screen.findByText("この提案には、もう回答できません。"),
		).toBeTruthy();
		expect(getCalls()).toBe(2);
		// 送信中の無効化が解けている
		expect(
			(screen.getByRole("button", { name: "参加する" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("送信失敗の取り直しで成立しなかったと分かっても一文を残す", async () => {
		postResponse = () =>
			jsonResponse(400, {
				error: {
					code: "VALIDATION_FAILED",
					message: "x",
					details: { reasons: ["invalid_status"] },
				},
			});
		getQueue = [
			() => jsonResponse(200, latchOf()),
			() => jsonResponse(200, latchOf({ status: "rejected" })),
		];
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(
			await screen.findByText("この提案は成立しませんでした。"),
		).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toBe(
			"この提案には、もう回答できません。",
		);
	});

	it("サーバーの失敗では送れませんでしたと知らせる", async () => {
		postResponse = () =>
			jsonResponse(500, { error: { code: "INTERNAL", message: "x" } });
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(
			await screen.findByText("送れませんでした。もう一度お試しください。"),
		).toBeTruthy();
		expect(getCalls()).toBe(2);
	});

	it("オフラインの失敗ではオフラインの案内を出す", async () => {
		postResponse = () => {
			throw new TypeError("network");
		};
		setup();
		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));
		expect(
			await screen.findByText("オフラインのため、いまは操作できません。"),
		).toBeTruthy();
	});

	it("回答待ちは30秒ごとに取り直し、matchedへ切り替わる", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		getQueue = [
			() =>
				jsonResponse(
					200,
					latchOf({ status: "partial_accept", my_response: "yes" }),
				),
			() => jsonResponse(200, matchedLatch()),
		];
		setup();
		expect(await screen.findByText("回答を取り消す")).toBeTruthy();
		expect(getCalls()).toBe(1);
		await act(async () => {
			vi.advanceTimersByTime(30_000);
		});
		expect(await screen.findByText("つながりました。")).toBeTruthy();
		expect(document.querySelector(".matched.is-fresh")).not.toBeNull();
	});

	it("提案の表示中は定期取得しない", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setup();
		await screen.findByRole("button", { name: "参加する" });
		await act(async () => {
			vi.advanceTimersByTime(60_000);
		});
		expect(getCalls()).toBe(1);
	});

	it("URLを開いた時点でmatchedなら演出しない", async () => {
		getQueue = [() => jsonResponse(200, matchedLatch())];
		setup();
		expect(await screen.findByText("つながりました。")).toBeTruthy();
		expect(document.querySelector(".matched")).not.toBeNull();
		expect(document.querySelector(".matched.is-fresh")).toBeNull();
	});

	it("キャッシュの回答待ちを開き直し・取り直しでmatchedでも演出しない", async () => {
		const client = createTestQueryClient();
		client.setDefaultOptions({
			queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, staleTime: 0 },
		});
		client.setQueryData(
			["latches", "L1"],
			latchOf({ status: "partial_accept", my_response: "yes" }),
		);
		getQueue = [() => jsonResponse(200, matchedLatch())];
		setupWith(client);
		expect(await screen.findByText("つながりました。")).toBeTruthy();
		expect(getCalls()).toBe(1);
		expect(document.querySelector(".matched")).not.toBeNull();
		expect(document.querySelector(".matched.is-fresh")).toBeNull();
	});
});
