/** /settings(Settings・F7c設計 §1.6・§3.1)の単体試験。プッシュのスイッチとテーマを確かめる */

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
import {
	browserPushEnv,
	disablePush,
	enablePush,
	type PushStatus,
} from "../../push/subscription";
import { appRoutes } from "../../router";
import { PATHS } from "../../routes/paths";
import { createTestQueryClient } from "../../test/helpers";
import { ThemeProvider } from "../../theme";

vi.mock("../../push/subscription", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../push/subscription")>()),
	enablePush: vi.fn(async () => "on"),
	disablePush: vi.fn(async () => {}),
}));

const DENIED =
	"ブラウザの設定で通知がオフになっています。提案は、アプリ内のお知らせでお伝えします。";
const UNSUPPORTED =
	"このブラウザでは通知を受け取れません。提案は、アプリ内のお知らせでお伝えします。";

/** 端末の初期状態を作る(on=許可済みで購読あり) */
const givenStatus = (status: PushStatus) => {
	const permission = {
		unsupported: "unsupported",
		denied: "denied",
		off: "default",
		on: "granted",
	}[status] as ReturnType<typeof browserPushEnv.permission>;
	vi.spyOn(browserPushEnv, "permission").mockReturnValue(permission);
	vi.spyOn(browserPushEnv, "pushManager").mockResolvedValue({
		getSubscription: async () => ({}),
	} as unknown as PushManager);
};

const setup = () => {
	authSession.setTokens("access-1", "refresh-1");
	const router = createMemoryRouter(appRoutes, {
		initialEntries: [PATHS.settings],
	});
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<ThemeProvider>
				<RouterProvider router={router} />
			</ThemeProvider>
		</QueryClientProvider>,
	);
	return router;
};

const switchEl = () =>
	screen.getByLabelText("プッシュ通知") as HTMLInputElement;

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
	);
	localStorage.clear();
	authSession.clear();
	vi.mocked(enablePush).mockReset().mockResolvedValue("on");
	vi.mocked(disablePush).mockReset().mockResolvedValue(undefined);
	window.matchMedia = vi.fn().mockReturnValue({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	authSession.clear();
	localStorage.clear();
});

describe("Settings", () => {
	it("状態の確認中はスイッチを押せず・意思ごとの文は出さない", async () => {
		givenStatus("on");
		setup();
		expect(switchEl().disabled).toBe(true);
		expect(switchEl().checked).toBe(false);
		await waitFor(() => expect(switchEl().checked).toBe(true));
		expect(
			screen.getByText(
				"提案と、つながったときだけ届きます。本文に内容は表示されません。",
			),
		).toBeTruthy();
		expect(screen.queryByText(/意思ごとのお知らせ/)).toBeNull();
	});

	it("onのスイッチを切るとdisablePushを呼び・offになる", async () => {
		givenStatus("on");
		setup();
		await waitFor(() => expect(switchEl().checked).toBe(true));
		fireEvent.click(switchEl());
		await waitFor(() => expect(switchEl().checked).toBe(false));
		expect(disablePush).toHaveBeenCalledTimes(1);
	});

	it("offのスイッチを入れるとenablePushを呼び・操作中は押せない", async () => {
		givenStatus("off");
		let resolve: (s: PushStatus) => void = () => {};
		vi.mocked(enablePush).mockImplementation(
			() => new Promise<PushStatus>((r) => (resolve = r)),
		);
		setup();
		await waitFor(() => expect(switchEl().disabled).toBe(false));
		fireEvent.click(switchEl());
		await waitFor(() => expect(switchEl().disabled).toBe(true));
		resolve("on");
		await waitFor(() => expect(switchEl().checked).toBe(true));
		expect(switchEl().disabled).toBe(false);
		expect(enablePush).toHaveBeenCalledTimes(1);
	});

	it("有効化の結果がoffならアプリ内のお知らせで届く旨を出す", async () => {
		givenStatus("off");
		vi.mocked(enablePush).mockResolvedValue("off");
		setup();
		await waitFor(() => expect(switchEl().disabled).toBe(false));
		fireEvent.click(switchEl());
		expect(
			await screen.findByText(/アプリ内のお知らせでお伝えします/),
		).toBeTruthy();
		expect(switchEl().checked).toBe(false);
	});

	it("有効化の結果がdeniedなら拒否済みの説明を出し押せなくなる", async () => {
		givenStatus("off");
		vi.mocked(enablePush).mockResolvedValue("denied");
		setup();
		await waitFor(() => expect(switchEl().disabled).toBe(false));
		fireEvent.click(switchEl());
		expect(await screen.findByText(DENIED)).toBeTruthy();
		expect(switchEl().disabled).toBe(true);
	});

	it("deniedは押せず・PushOffの説明を出す", async () => {
		givenStatus("denied");
		setup();
		expect(await screen.findByText(DENIED)).toBeTruthy();
		expect(switchEl().disabled).toBe(true);
		expect(switchEl().checked).toBe(false);
	});

	it("unsupportedは押せず・アプリ内のお知らせで届く旨を出す", async () => {
		givenStatus("unsupported");
		setup();
		expect(await screen.findByText(UNSUPPORTED)).toBeTruthy();
		expect(switchEl().disabled).toBe(true);
	});

	it("テーマのラジオ3つで表示を切り替える", async () => {
		givenStatus("off");
		setup();
		const system = screen.getByLabelText("端末の設定に合わせる");
		const light = screen.getByLabelText("昼(明るい紙)");
		const dark = screen.getByLabelText("夜(暗い紙)");
		expect((system as HTMLInputElement).checked).toBe(true);
		fireEvent.click(dark);
		await waitFor(() => expect((dark as HTMLInputElement).checked).toBe(true));
		expect(localStorage.getItem("latch.theme")).toBe("dark");
		fireEvent.click(light);
		expect(localStorage.getItem("latch.theme")).toBe("light");
		fireEvent.click(system);
		expect(localStorage.getItem("latch.theme")).toBe("system");
	});

	it("戻るは/meへ", async () => {
		givenStatus("off");
		const router = setup();
		fireEvent.click(screen.getByLabelText("戻る"));
		await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.me));
	});
});
