/**
 * 意思の詳細(/intents/:id・F8a設計 §1.3)の試験。
 * 状態ごとの表示・操作・スイッチ・取り下げの確認・失敗時の扱いを確かめる(fetchはモック)
 */

import type { IntentDTO, LatchDTO } from "@latch/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { readPendingCompose } from "../../intents/composeState";
import { createAppQueryClient } from "../../offline/persister";
import { appRoutes } from "../../router";
import { createTestQueryClient } from "../../test/helpers";
import { restoreOnline, setOnline } from "../../test/offline";
import { countMatches } from "./IntentDetail";

const DAY = 24 * 3_600_000;
const iso = (offsetMs: number): string =>
	new Date(Date.now() + offsetMs).toISOString();
const ID = "01J00000000000000000000001";

const intentOf = (over: Partial<IntentDTO> = {}): IntentDTO => ({
	id: ID,
	form: "connection",
	topic: "絵を見せ合う",
	category: null,
	raw_text: "イラストを描く人と、月1くらいで絵を見せ合いたい。",
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	hard_constraints: [],
	soft_constraints: ["初心者", "雑談"],
	negative_constraints: [],
	visibility: "hidden_until_match",
	notification_level: "proposals_only",
	alcohol_involved: false,
	status: "active",
	version: 1,
	expires_at: iso(18 * DAY),
	created_at: iso(-12 * DAY),
	updated_at: iso(-12 * DAY),
	...over,
});

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const connection = (my_intent_id: string, id: string): LatchDTO =>
	({
		id,
		form: "connection",
		status: "matched",
		response_deadline: iso(DAY),
		participants_count: 2,
		my_response: "yes",
		score: 0.5,
		my_intent_id,
		matched_at: iso(-DAY),
	}) as LatchDTO;

let intent: IntentDTO;
let intent404: boolean;
let connections: LatchDTO[];
let pauseResponse: () => Response | Promise<Response>;
let patchResponse: () => Response | Promise<Response>;
let deleteResponse: () => Response | Promise<Response>;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const path = `/v1/intents/${ID}`;
		// オフラインの端末ではfetchが通信の失敗(TypeError)になる
		if (!navigator.onLine) throw new TypeError("Failed to fetch");
		if (url === "/v1/users/me") return json({ id: "me" });
		if (url === `${path}/pause` && method === "POST") return pauseResponse();
		if (url === `${path}/resume` && method === "POST") {
			intent = { ...intent, status: "active" };
			return json(intent);
		}
		if (url === path && method === "PATCH") return patchResponse();
		if (url === path && method === "DELETE") return deleteResponse();
		if (url === path)
			return intent404
				? json({ error: { code: "NOT_FOUND", message: "x" } }, 404)
				: json(intent);
		if (url.startsWith("/v1/intents?"))
			return json({ items: [intent], next_cursor: null });
		if (url.startsWith("/v1/latches?type=matched"))
			return json({ items: connections, next_cursor: null });
		if (url.startsWith("/v1/latches?"))
			return json({ items: [], next_cursor: null });
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);

const callsTo = (method: string, url: string) =>
	fetchMock.mock.calls.filter(
		([u, i]) => String(u) === url && (i?.method ?? "GET") === method,
	);

const open = (client: QueryClient = createTestQueryClient()) => {
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [`/intents/${ID}`],
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-intent", null);
	intent = intentOf();
	intent404 = false;
	connections = [];
	pauseResponse = () => {
		intent = { ...intent, status: "paused" };
		return json(intent);
	};
	patchResponse = () => {
		intent = { ...intent, notification_level: "muted" };
		return json(intent);
	};
	deleteResponse = () => new Response(null, { status: 204 });
	sessionStorage.clear();
});
afterEach(() => {
	cleanup();
	setOnline(true);
	restoreOnline();
	vi.unstubAllGlobals();
	authSession.clear();
});

describe("countMatches", () => {
	it("my_intent_idが一致する件数", () => {
		expect(
			countMatches([connection("a", "1"), connection("b", "2")], "a"),
		).toBe(1);
		expect(countMatches([], "a")).toBe(0);
	});
});

describe("IntentDetail 表示", () => {
	it("つながり(active)の数字と読み解いた条件", async () => {
		connections = [connection(ID, "L1"), connection(ID, "L2")];
		open();
		await screen.findByText("期限まで");
		expect(screen.getByText("預けて")).toBeTruthy();
		expect(screen.getByText("これまで")).toBeTruthy();
		await waitFor(() => {
			expect(document.body.textContent).toContain("2回つながった");
		});
		expect(document.body.textContent).toContain("12日");
		expect(screen.getByText("読み解いた条件")).toBeTruthy();
		expect(screen.getByText("絵を見せ合う")).toBeTruthy();
		expect(screen.getByText("初心者")).toBeTruthy();
		expect(screen.getByText("指定なし(全国)")).toBeTruthy();
		expect(screen.getByText("2人(あなたと相手)")).toBeTruthy();
		expect(screen.getByText(/まで\(\d+日\)/)).toBeTruthy();
		expect(screen.getByText("預けている")).toBeTruthy();
	});

	it("機会は開始・期限の帯と日時・予算・お酒を出す", async () => {
		intent = intentOf({
			form: "occasion",
			raw_text: "今夜、軽く飲みに行きたい。",
			time: { start: iso(2 * 3_600_000), end: null },
			expires_at: iso(5 * 3_600_000),
			budget: { min: 0, max: 5000, currency: "JPY" },
			alcohol_involved: true,
			participants: { min: 2, max: 4, includes_owner: true },
		});
		open();
		await screen.findByText(/^開始・/);
		expect(screen.getByText(/^期限・/)).toBeTruthy();
		expect(screen.getByText("日時")).toBeTruthy();
		expect(screen.getByText("場所")).toBeTruthy();
		expect(screen.getByText("2〜4人")).toBeTruthy();
		expect(screen.getByText("5,000円以内")).toBeTruthy();
		expect(screen.getByText("含む(20歳以上の方どうし)")).toBeTruthy();
	});

	it("お酒を含まない機会", async () => {
		intent = intentOf({
			form: "occasion",
			time: { start: iso(2 * 3_600_000), end: null },
		});
		open();
		expect(await screen.findByText("含まない")).toBeTruthy();
	});

	it("404は「見つかりませんでした」とホームへのリンク", async () => {
		intent404 = true;
		open();
		expect(await screen.findByText("見つかりませんでした")).toBeTruthy();
		const link = screen.getByRole("link", { name: /ホーム/ });
		expect(link.getAttribute("href")).toBe("/home");
	});
});

describe("IntentDetail 操作", () => {
	it("activeは一時停止・内容を直す・取り下げる・スイッチ", async () => {
		open();
		await screen.findByRole("button", { name: /一時停止する/ });
		const edit = screen.getByRole("link", { name: /内容を直す/ });
		expect(edit.getAttribute("href")).toBe(`/intents/${ID}/edit`);
		expect(screen.getByRole("button", { name: "取り下げる" })).toBeTruthy();
		const sw = screen.getByRole("checkbox") as HTMLInputElement;
		expect(sw.checked).toBe(true);
		expect(sw.disabled).toBe(false);
		expect(screen.getByText("提案をお知らせする")).toBeTruthy();
	});

	it("pausedは再開・スイッチはdisabled・説明を出す", async () => {
		intent = intentOf({ status: "paused" });
		open();
		await screen.findByRole("button", { name: /再開する/ });
		expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
			true,
		);
		expect(
			screen.getByText(
				"一時停止中は、提案が届きません。いつでも再開できます。",
			),
		).toBeTruthy();
		expect(screen.queryByRole("link", { name: /内容を直す/ })).toBeNull();
	});

	it("expiredはもう一度預ける・一覧から消す・期限切れの日付", async () => {
		intent = intentOf({ status: "expired", expires_at: iso(-3 * DAY) });
		const router = open();
		fireEvent.click(
			await screen.findByRole("button", { name: "もう一度預ける" }),
		);
		expect(readPendingCompose()?.raw_text).toBe(intent.raw_text);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/compose"),
		);
	});

	it("expiredの説明に期限が切れた日を出す", async () => {
		intent = intentOf({ status: "expired", expires_at: iso(-3 * DAY) });
		open();
		await screen.findByRole("button", { name: "一覧から消す" });
		expect(document.body.textContent).toMatch(/\d+月\d+日に期限が切れました。/);
	});

	it("matched・cancelledには操作がない", async () => {
		intent = intentOf({ status: "matched" });
		open();
		await screen.findByText("つながった");
		expect(
			screen.queryByRole("button", { name: /一時停止|再開|取り下げる/ }),
		).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("スイッチのオフでmuted・オンでproposals_only", async () => {
		open();
		const sw = (await screen.findByRole("checkbox")) as HTMLInputElement;
		fireEvent.click(sw);
		await waitFor(() =>
			expect(callsTo("PATCH", `/v1/intents/${ID}`)).toHaveLength(1),
		);
		expect(
			JSON.parse(String(callsTo("PATCH", `/v1/intents/${ID}`)[0]?.[1]?.body)),
		).toEqual({
			notification_level: "muted",
		});
		await waitFor(() => expect(sw.checked).toBe(false));
		patchResponse = () =>
			json({ ...intent, notification_level: "proposals_only" });
		fireEvent.click(sw);
		await waitFor(() =>
			expect(callsTo("PATCH", `/v1/intents/${ID}`)).toHaveLength(2),
		);
		expect(
			JSON.parse(String(callsTo("PATCH", `/v1/intents/${ID}`)[1]?.[1]?.body)),
		).toEqual({
			notification_level: "proposals_only",
		});
	});

	it("スイッチのPATCHが通信失敗なら元の値に戻りオフラインの案内を出す", async () => {
		patchResponse = () => {
			throw new TypeError("Failed to fetch");
		};
		open();
		const sw = (await screen.findByRole("checkbox")) as HTMLInputElement;
		fireEvent.click(sw);
		expect(
			await screen.findByText("オフラインのため、いまは操作できません。"),
		).toBeTruthy();
		expect(sw.checked).toBe(true);
	});

	it("一時停止・再開の成功でトーストを出す", async () => {
		open();
		fireEvent.click(
			await screen.findByRole("button", { name: /一時停止する/ }),
		);
		expect(await screen.findByText("一時停止しました。")).toBeTruthy();
		fireEvent.click(await screen.findByRole("button", { name: /再開する/ }));
		expect(await screen.findByText("再開しました。")).toBeTruthy();
	});

	it("一時停止がinvalid_statusなら単一取得をやり直す", async () => {
		pauseResponse = () =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "x",
						details: { reasons: ["invalid_status"] },
					},
				},
				400,
			);
		open();
		fireEvent.click(
			await screen.findByRole("button", { name: /一時停止する/ }),
		);
		await waitFor(() =>
			expect(callsTo("GET", `/v1/intents/${ID}`).length).toBeGreaterThan(1),
		);
	});

	it("取り下げるは確認のシートを経て1回だけDELETEしホームへ戻る", async () => {
		const router = open();
		fireEvent.click(await screen.findByRole("button", { name: "取り下げる" }));
		expect(
			screen.getByText(
				"この意思を取り下げます。届いている提案も取り消されます。",
			),
		).toBeTruthy();
		expect(callsTo("DELETE", `/v1/intents/${ID}`)).toHaveLength(0);
		const dialog = screen.getByRole("dialog");
		const confirm = Array.from(dialog.querySelectorAll("button")).find(
			(b) => b.textContent === "取り下げる",
		) as HTMLButtonElement;
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
		expect(callsTo("DELETE", `/v1/intents/${ID}`)).toHaveLength(1);
		expect(await screen.findByText("取り下げました。")).toBeTruthy();
	});

	/** 確認のシートを経て取り下げを1回送る */
	const confirmDelete = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "取り下げる" }));
		const dialog = screen.getByRole("dialog");
		const confirm = Array.from(dialog.querySelectorAll("button")).find(
			(b) => b.textContent === "取り下げる",
		) as HTMLButtonElement;
		fireEvent.click(confirm);
	};

	it("取り下げが503(一時的に受け付けられない)ならサーバーの「少し待って」の文言を出して留まる(LAT-126)", async () => {
		deleteResponse = () =>
			json(
				{
					error: {
						code: "TEMPORARILY_UNAVAILABLE",
						message:
							"削除できませんでした。少し待ってからもう一度お試しください",
						details: {},
					},
				},
				503,
			);
		const router = open();
		await confirmDelete();
		expect(
			await screen.findByText(
				"削除できませんでした。少し待ってからもう一度お試しください",
			),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(`/intents/${ID}`);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("取り下げが500なら一般の一文を出す(503の文言と分ける)", async () => {
		deleteResponse = () =>
			json(
				{
					error: {
						code: "INTERNAL",
						message: "削除に失敗しました。時間を置いて再度お試しください",
						details: {},
					},
				},
				500,
			);
		open();
		await confirmDelete();
		expect(
			await screen.findByText(
				"うまくいきませんでした。もう一度お試しください。",
			),
		).toBeTruthy();
	});

	it("確認のシートはやめるで閉じる", async () => {
		open();
		fireEvent.click(await screen.findByRole("button", { name: "取り下げる" }));
		fireEvent.click(screen.getByRole("button", { name: "やめる" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(callsTo("DELETE", `/v1/intents/${ID}`)).toHaveLength(0);
	});
});

describe("IntentDetail オフライン", () => {
	/** アプリと同じQueryClient(取得の再試行だけ外す) */
	const appClient = (): QueryClient => {
		const client = createAppQueryClient();
		client.setDefaultOptions({
			...client.getDefaultOptions(),
			queries: { retry: false },
		});
		return client;
	};

	it("開いた後にオフラインになって一時停止を押すと案内を出し・回復しても送り直さない", async () => {
		open(appClient());
		const button = await screen.findByRole("button", { name: /一時停止する/ });
		act(() => setOnline(false));

		fireEvent.click(button);

		expect(
			await screen.findByText("オフラインのため、いまは操作できません。"),
		).toBeTruthy();
		// 止まったままにならず、もう一度押せる
		expect((button as HTMLButtonElement).disabled).toBe(false);
		const attempts = callsTo("POST", `/v1/intents/${ID}/pause`).length;
		expect(attempts).toBe(1);

		act(() => setOnline(true));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(callsTo("POST", `/v1/intents/${ID}/pause`)).toHaveLength(attempts);
		expect(intent.status).toBe("active");
		expect(screen.queryByText("一時停止しました。")).toBeNull();
	});

	it("オフラインで開いて単一の取得が無いときは読み込めなかった表示と帯を出す", async () => {
		setOnline(false);
		open(appClient());

		expect(await screen.findByText("読み込めませんでした。")).toBeTruthy();
		expect(
			screen.getByText("オフラインです。最後に確かめた内容を表示しています。"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "もう一度読み込む" }),
		).toBeTruthy();
	});
});
