/** /me/profile(Profile・F7c設計)の単体試験 */

import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../../auth/session";
import { validateIconFile } from "../../me/queries";
import { appRoutes } from "../../router";
import { PATHS } from "../../routes/paths";
import { createTestQueryClient } from "../../test/helpers";

const json = (body: unknown, status = 200): Response =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let me: { id: string; display_name: string; bio: string; has_icon: boolean };
let patchResult: () => Response;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url === "/v1/users/me" && method === "GET") return json(me);
		if (url === "/v1/users/me" && method === "PATCH") return patchResult();
		if (url === "/v1/users/me/icon" && method === "POST")
			return json({ ...me, has_icon: true });
		if (url === "/v1/users/me/icon" && method === "DELETE")
			return json(null, 204);
		if (url.startsWith("/v1/notifications")) {
			return json({ items: [], next_cursor: null, unread_count: 0 });
		}
		throw new Error(`想定外のfetch: ${method} ${url}`);
	},
);

const calls = (method: string, url: string) =>
	fetchMock.mock.calls.filter(
		([u, i]) => String(u) === url && (i?.method ?? "GET") === method,
	);

const setup = async () => {
	authSession.setTokens("access-1", "refresh-1");
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.me, PATHS.profile],
		initialIndex: 1,
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	await screen.findByDisplayValue("みなと");
	return router;
};

beforeEach(() => {
	me = {
		id: "U".repeat(26),
		display_name: "みなと",
		bio: "夜に散歩しています。",
		has_icon: false,
	};
	patchResult = () => json({ ...me });
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	localStorage.clear();
	authSession.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("validateIconFile", () => {
	it("形式と大きさを判定する", () => {
		const f = (type: string, size = 10) => {
			const file = new File(["x"], "a", { type });
			Object.defineProperty(file, "size", { value: size });
			return file;
		};
		expect(validateIconFile(f("image/png"))).toBeNull();
		expect(validateIconFile(f("image/webp"))).toBeNull();
		expect(validateIconFile(f("image/gif"))).toBe("bad_type");
		expect(validateIconFile(f("image/png", 1_048_577))).toBe("too_large");
	});
});

describe("Profile", () => {
	it("初期値とカウンターを出す", async () => {
		await setup();
		expect(screen.getByLabelText("表示名")).toHaveProperty("value", "みなと");
		expect(screen.getByText("/ 40", { exact: false }).textContent).toContain(
			"3 / 40",
		);
		expect(document.body.textContent).toContain("10 / 200");
	});

	it("表示名が空だと[保存]が押せない", async () => {
		await setup();
		fireEvent.change(screen.getByLabelText("表示名"), {
			target: { value: " " },
		});
		expect(screen.getByRole("button", { name: "保存" })).toHaveProperty(
			"disabled",
			true,
		);
	});

	it("ひとことだけ変えるとbioだけ送って/meへ戻る", async () => {
		const router = await setup();
		fireEvent.change(screen.getByLabelText(/ひとこと/), {
			target: { value: "朝も散歩します。" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.me));
		const patch = calls("PATCH", "/v1/users/me");
		expect(patch).toHaveLength(1);
		expect(JSON.parse(String(patch[0]?.[1]?.body))).toEqual({
			bio: "朝も散歩します。",
		});
	});

	it("変更なしの[保存]は送らず/meへ戻る", async () => {
		const router = await setup();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.me));
		expect(calls("PATCH", "/v1/users/me")).toHaveLength(0);
	});

	it("1MB超とGIFは送らず注意を出す", async () => {
		await setup();
		const input = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const gif = new File(["x"], "a.gif", { type: "image/gif" });
		fireEvent.change(input, { target: { files: [gif] } });
		expect(await screen.findByText("PNG・JPEG・WebP、1MBまで。")).toBeTruthy();
		const big = new File(["x"], "a.png", { type: "image/png" });
		Object.defineProperty(big, "size", { value: 2_000_000 });
		fireEvent.change(input, { target: { files: [big] } });
		expect(calls("POST", "/v1/users/me/icon")).toHaveLength(0);
		expect(
			screen.getAllByText("PNG・JPEG・WebP、1MBまで。").length,
		).toBeGreaterThan(0);
	});

	it("PNGを選ぶとアイコンをPOSTする", async () => {
		await setup();
		const input = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const png = new File(["x"], "a.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [png] } });
		await waitFor(() =>
			expect(calls("POST", "/v1/users/me/icon")).toHaveLength(1),
		);
		expect(calls("POST", "/v1/users/me/icon")[0]?.[1]?.body).toBe(png);
	});

	it("[既定のアイコンに戻す]でDELETEする", async () => {
		me.has_icon = true;
		await setup();
		fireEvent.click(
			screen.getByRole("button", { name: "既定のアイコンに戻す" }),
		);
		await waitFor(() =>
			expect(calls("DELETE", "/v1/users/me/icon")).toHaveLength(1),
		);
	});

	it("PATCH失敗では画面に留まり共通の失敗文を出す", async () => {
		patchResult = () =>
			json({ error: { code: "INTERNAL", message: "x", details: {} } }, 500);
		const router = await setup();
		fireEvent.change(screen.getByLabelText("表示名"), {
			target: { value: "あお" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(
			await screen.findByText(
				"送れませんでした。時間をおいて、もう一度お試しください。",
			),
		).toBeTruthy();
		expect(router.state.location.pathname).toBe(PATHS.profile);
	});

	it("400は表示名の下に出す", async () => {
		patchResult = () =>
			json(
				{
					error: {
						code: "VALIDATION_FAILED",
						message: "表示名が不正です",
						details: {},
					},
				},
				400,
			);
		await setup();
		fireEvent.change(screen.getByLabelText("表示名"), {
			target: { value: "あお" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(await screen.findByText("表示名が不正です")).toBeTruthy();
	});
});
