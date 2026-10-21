/**
 * MessageList(F6b設計 §1.3)の単体試験。日付区切り・自分/相手・送り主名・0件の文言
 */

import type { LatchDTO, MessageDTO } from "@latch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

const NOW = new Date("2026-10-21T03:00:00Z");

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "L1",
		form: "connection",
		status: "matched",
		participants_count: 2,
		matched_at: "2026-10-20T01:00:00Z",
		members: [
			{ user_id: "u2", display_name: "ミナト", bio: null, has_icon: false },
		],
		...over,
	}) as LatchDTO;

const msg = (id: string, user_id: string, iso: string): MessageDTO => ({
	id,
	user_id,
	body: `本文${id}`,
	created_at: iso,
	client_id: null,
});

const three = [
	msg("01", "u2", "2026-10-20T01:00:00Z"),
	msg("02", "me", "2026-10-20T01:05:00Z"),
	msg("03", "u2", "2026-10-21T01:00:00Z"),
];

afterEach(cleanup);

describe("MessageList", () => {
	it("2日にまたがると区切りが「10月20日」「今日」で入る", () => {
		const { container } = render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={three}
				now={NOW}
				pending={[]}
				onRetry={() => {}}
				onMessageMenu={() => {}}
			/>,
		);
		const days = [...container.querySelectorAll(".chat__day")].map(
			(e) => e.textContent,
		);
		expect(days).toEqual(["10月20日", "今日"]);
		expect(container.querySelectorAll(".msg--mine")).toHaveLength(1);
		expect(container.querySelectorAll(".msg--theirs")).toHaveLength(2);
		expect(screen.getAllByText("10:05")).toHaveLength(1);
	});

	it("1対1では送り主名が出ない", () => {
		const { container } = render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={three}
				now={NOW}
				pending={[]}
				onRetry={() => {}}
				onMessageMenu={() => {}}
			/>,
		);
		expect(container.querySelector(".msg__who")).toBeNull();
	});

	it("グループでは相手の発言に送り主名・抜けた人はつながっていた相手", () => {
		const { container } = render(
			<MessageList
				latch={latchOf({ participants_count: 3 })}
				meId="me"
				messages={[...three, msg("04", "gone", "2026-10-21T01:10:00Z")]}
				now={NOW}
				pending={[]}
				onRetry={() => {}}
				onMessageMenu={() => {}}
			/>,
		);
		const whos = [...container.querySelectorAll(".msg__who")].map(
			(e) => e.textContent,
		);
		expect(whos).toEqual(["ミナト", "ミナト", "つながっていた相手"]);
	});

	it("0件なら最初のひとことの案内", () => {
		render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={[]}
				now={NOW}
				pending={[]}
				onRetry={() => {}}
				onMessageMenu={() => {}}
			/>,
		);
		expect(
			screen.getByText("最初のひとことは、短くて大丈夫です。"),
		).toBeTruthy();
	});

	it("送信中・失敗の吹き出しを末尾に出し・失敗は再送できる", () => {
		const retried: string[] = [];
		const { container } = render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={three}
				now={NOW}
				pending={[
					{ clientId: "c1", body: "送信中の本文", state: "sending" },
					{ clientId: "c2", body: "失敗の本文", state: "failed" },
				]}
				onRetry={(id) => retried.push(id)}
				onMessageMenu={() => {}}
			/>,
		);
		expect(container.querySelectorAll(".msg.is-failed")).toHaveLength(1);
		screen.getByRole("button", { name: "もう一度送る" }).click();
		expect(retried).toEqual(["c2"]);
		expect(screen.getByText("送信中の本文")).toBeTruthy();
	});

	it("相手の発言にだけ「このメッセージの操作」があり・押すとその発言でonMessageMenu", () => {
		const onMessageMenu = vi.fn();
		const { container } = render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={three}
				now={NOW}
				pending={[
					{ clientId: "c1", body: "送信中の本文", state: "sending" },
					{ clientId: "c2", body: "失敗の本文", state: "failed" },
				]}
				onRetry={() => {}}
				onMessageMenu={onMessageMenu}
			/>,
		);
		const buttons = screen.getAllByRole("button", {
			name: "このメッセージの操作",
		});
		expect(buttons).toHaveLength(2);
		for (const mine of container.querySelectorAll(".msg--mine")) {
			expect(mine.querySelector(".msg__more")).toBeNull();
		}
		fireEvent.click(buttons[1] as HTMLElement);
		expect(onMessageMenu).toHaveBeenCalledTimes(1);
		expect(onMessageMenu.mock.calls[0]?.[0].id).toBe("03");
	});

	it("相手の発言のcontextmenuでも開き既定のメニューを止める・自分の発言では開かない", () => {
		const onMessageMenu = vi.fn();
		render(
			<MessageList
				latch={latchOf()}
				meId="me"
				messages={three}
				now={NOW}
				pending={[]}
				onRetry={() => {}}
				onMessageMenu={onMessageMenu}
			/>,
		);
		const theirs = screen.getByText("本文01");
		const notPrevented = fireEvent.contextMenu(theirs);
		expect(notPrevented).toBe(false);
		expect(onMessageMenu).toHaveBeenCalledTimes(1);
		expect(onMessageMenu.mock.calls[0]?.[0].id).toBe("01");
		fireEvent.contextMenu(screen.getByText("本文02"));
		expect(onMessageMenu).toHaveBeenCalledTimes(1);
	});
});
