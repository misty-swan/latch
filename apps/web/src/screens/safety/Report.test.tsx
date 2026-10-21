/**
 * 通報画面(/latches/:id/report・F7c設計 §1.7)の単体試験。
 * 入口ごとの欄・本文・連打の防止・404の文言・戻り先を確かめる
 */

import type { LatchDTO } from "@latch/shared";
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
import { appRoutes } from "../../router";
import { createTestQueryClient } from "../../test/helpers";

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "L1",
		form: "connection",
		status: "matched",
		response_deadline: new Date().toISOString(),
		participants_count: 2,
		my_response: "yes",
		score: 0.9,
		my_intent_id: "i1",
		matched_at: new Date().toISOString(),
		members: [
			{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
		],
		...over,
	}) as LatchDTO;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

let latch: LatchDTO;
let postResponse: () => Promise<Response>;
const fetchMock = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url === "/v1/latches/L1") return json(latch);
		if (url === "/v1/reports") return postResponse();
		if (url.startsWith("/v1/notifications")) {
			return json({ items: [], next_cursor: null, unread_count: 0 });
		}
		if (url === "/v1/users/me") return json({ id: "u1", has_icon: false });
		throw new Error(`想定外のfetch: ${url}`);
	},
);

const reportBodies = (): unknown[] =>
	fetchMock.mock.calls
		.filter(([u]) => String(u) === "/v1/reports")
		.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const open = (
	entry: string | { pathname: string; search?: string; state?: unknown },
) => {
	const router = createMemoryRouter(appRoutes, { initialEntries: [entry] });
	render(
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
};

const send = () => screen.getByRole("button", { name: "通報する" });

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
	authSession.setTokens("access-report", null);
	latch = latchOf();
	postResponse = async () => json({ received: true }, 201);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Report", () => {
	it("提案段階: 対象の欄なしで理由を選んで通報でき、完了後[閉じる]で提案へ戻る", async () => {
		latch = latchOf({ status: "proposed", members: undefined });
		const router = open("/latches/L1/report");
		await screen.findByText(/通報したことは、相手には通知されません/);
		expect(screen.queryByText("対象")).toBeNull();
		expect((send() as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByLabelText("スパム・勧誘"));
		fireEvent.click(send());
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toEqual([
			{ latch_id: "L1", target: "proposal", reason: "spam" },
		]);
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1"),
		);
	});

	it("成立後の1対1: プロフィール/アイコンを選べて相手は唯一のmembers", async () => {
		const router = open("/latches/L1/report");
		await screen.findByLabelText("プロフィール(表示名・ひとこと)");
		fireEvent.click(screen.getByLabelText("アイコン"));
		fireEvent.click(screen.getByLabelText("嫌がらせ"));
		fireEvent.change(screen.getByLabelText(/くわしく/), {
			target: { value: "  しつこい  " },
		});
		fireEvent.click(send());
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toEqual([
			{
				latch_id: "L1",
				target: "icon",
				reason: "harassment",
				note: "しつこい",
				reportee_user_id: "u2",
			},
		]);
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1/chat"),
		);
	});

	it("グループ: 相手を選ぶまで通報できない", async () => {
		latch = latchOf({
			participants_count: 3,
			members: [
				{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
				{ user_id: "u3", display_name: "アオイ", bio: null, has_icon: false },
			],
		});
		open("/latches/L1/report");
		await screen.findByText("相手");
		fireEvent.click(screen.getByLabelText("プロフィール(表示名・ひとこと)"));
		fireEvent.click(screen.getByLabelText("その他"));
		expect((send() as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByLabelText("アオイ"));
		expect((send() as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(send());
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toEqual([
			{
				latch_id: "L1",
				target: "profile",
				reason: "other",
				reportee_user_id: "u3",
			},
		]);
	});

	it("グループ: ブロックの確認から来たときは引き継いだ相手が選ばれている(01 D-10)", async () => {
		latch = latchOf({
			participants_count: 3,
			members: [
				{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
				{ user_id: "u3", display_name: "アオイ", bio: null, has_icon: false },
			],
		});
		open({ pathname: "/latches/L1/report", state: { reporteeId: "u3" } });
		await screen.findByText("相手");
		expect((screen.getByLabelText("アオイ") as HTMLInputElement).checked).toBe(
			true,
		);
		fireEvent.click(screen.getByLabelText("アイコン"));
		fireEvent.click(screen.getByLabelText("嫌がらせ"));
		fireEvent.click(send());
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toEqual([
			{
				latch_id: "L1",
				target: "icon",
				reason: "harassment",
				reportee_user_id: "u3",
			},
		]);
	});

	it("引き継いだ相手がmembersに無ければ選ばれていない扱いで送れない", async () => {
		latch = latchOf({
			participants_count: 3,
			members: [
				{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
				{ user_id: "u3", display_name: "アオイ", bio: null, has_icon: false },
			],
		});
		open({ pathname: "/latches/L1/report", state: { reporteeId: "u9" } });
		await screen.findByText("相手");
		fireEvent.click(screen.getByLabelText("アイコン"));
		fireEvent.click(screen.getByLabelText("嫌がらせ"));
		expect((send() as HTMLButtonElement).disabled).toBe(true);
	});

	it("?message=&user=: 対象・相手の欄なしで発言を引用して通報する", async () => {
		open({
			pathname: "/latches/L1/report",
			search: "?message=M1&user=u2",
			state: { quote: "こんにちは" },
		});
		await screen.findByText("こんにちは");
		expect(screen.queryByText("対象")).toBeNull();
		expect(screen.queryByText("相手")).toBeNull();
		fireEvent.click(screen.getByLabelText("不適切な内容"));
		fireEvent.click(send());
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toEqual([
			{
				latch_id: "L1",
				target: "message",
				reason: "inappropriate",
				message_id: "M1",
				reportee_user_id: "u2",
			},
		]);
	});

	it("くわしくは500字まで", async () => {
		open("/latches/L1/report");
		const note = (await screen.findByLabelText(
			/くわしく/,
		)) as HTMLTextAreaElement;
		expect(note.maxLength).toBe(500);
	});

	it("送信中は[通報する]が押せず・連打してもPOSTは1回", async () => {
		let release: (r: Response) => void = () => {};
		postResponse = () => new Promise<Response>((r) => (release = r));
		open("/latches/L1/report");
		await screen.findByLabelText("アイコン");
		fireEvent.click(screen.getByLabelText("プロフィール(表示名・ひとこと)"));
		fireEvent.click(screen.getByLabelText("スパム・勧誘"));
		fireEvent.click(send());
		await waitFor(() =>
			expect((send() as HTMLButtonElement).disabled).toBe(true),
		);
		fireEvent.click(send());
		fireEvent.click(send());
		expect(reportBodies()).toHaveLength(1);
		release(json({ received: true }, 201));
		await screen.findByText("通報を受け付けました。");
		expect(reportBodies()).toHaveLength(1);
	});

	it("404は「この操作はできませんでした。」・他の失敗は共通文で再操作できる", async () => {
		postResponse = async () =>
			json({ error: { code: "NOT_FOUND", message: "x", details: {} } }, 404);
		open("/latches/L1/report");
		await screen.findByLabelText("アイコン");
		fireEvent.click(screen.getByLabelText("アイコン"));
		fireEvent.click(screen.getByLabelText("スパム・勧誘"));
		fireEvent.click(send());
		await screen.findByText("この操作はできませんでした。");
		postResponse = async () =>
			json({ error: { code: "INTERNAL", message: "x", details: {} } }, 500);
		fireEvent.click(send());
		await screen.findByText(
			"送れませんでした。時間をおいて、もう一度お試しください。",
		);
	});

	it("[やめる]は成立後ならチャットへ戻る", async () => {
		const router = open("/latches/L1/report");
		await screen.findByLabelText("アイコン");
		fireEvent.click(screen.getByRole("link", { name: "やめる" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/latches/L1/chat"),
		);
	});
});
