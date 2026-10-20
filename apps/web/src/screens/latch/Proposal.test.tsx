/**
 * Proposal画面(表示のみ・F4c設計)の単体試験。回答UIは2択・scoreを出さない・
 * busy中の連打防止・残り時間の15秒ごとの更新を確かめる
 */

import type { LatchDTO } from "@latch/shared";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Proposal } from "./Proposal";

const NOW = new Date("2026-10-20T03:00:00.000Z");

const latchOf = (over: Partial<LatchDTO> = {}): LatchDTO =>
	({
		id: "l1",
		form: "occasion",
		status: "proposed",
		response_deadline: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
		participants_count: 2,
		my_response: null,
		score: 0.87,
		my_intent_id: "i1",
		matched_at: null,
		...over,
	}) as LatchDTO;

const view = (latch: LatchDTO, busy = false, onJoin = vi.fn()) => (
	<MemoryRouter>
		<Proposal
			latch={latch}
			now={NOW}
			busy={busy}
			notice={null}
			onJoin={onJoin}
			onDefer={vi.fn()}
		/>
	</MemoryRouter>
);

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Proposal", () => {
	it("ボタンは参加する・今回は見送るの2つだけ(noの操作は無い)", () => {
		const { container } = render(view(latchOf()));
		const names = screen.getAllByRole("button").map((b) => b.textContent);
		expect(names).toEqual(["参加する", "今回は見送る"]);
		expect(container.textContent).not.toMatch(/拒否|参加しない/);
	});

	it("scoreと相手の情報を表示しない", () => {
		const { container } = render(view(latchOf({ score: 0.87 })));
		expect(container.textContent).not.toContain("0.87");
		expect(container.textContent).not.toContain("87");
	});

	it("グループは人数と全員の注記", () => {
		render(view(latchOf({ participants_count: 4 })));
		expect(screen.getByText("あなたを含む4人で成立します")).toBeTruthy();
		expect(screen.getByText(/全員が参加すると/)).toBeTruthy();
	});

	it("busyのとき両ボタンがdisabledで、連打してもonJoinは1回", () => {
		const onJoin = vi.fn();
		const latch = latchOf();
		const { rerender } = render(view(latch, false, onJoin));
		fireEvent.click(screen.getByRole("button", { name: "参加する" }));
		rerender(view(latch, true, onJoin));
		fireEvent.click(screen.getByRole("button", { name: "参加する" }));
		expect(onJoin).toHaveBeenCalledTimes(1);
		for (const b of screen.getAllByRole("button")) {
			expect((b as HTMLButtonElement).disabled).toBe(true);
		}
	});

	it("15秒ごとに残り時間を更新する", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		render(view(latchOf()));
		expect(screen.getByText("あと3分")).toBeTruthy();
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(screen.getByText("あと2分")).toBeTruthy();
	});

	it("noticeは.screen__footの先頭にstatusとして出る", () => {
		render(
			<MemoryRouter>
				<Proposal
					latch={latchOf()}
					now={NOW}
					busy={false}
					notice="通信に失敗しました"
					onJoin={vi.fn()}
					onDefer={vi.fn()}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("status").textContent).toBe("通信に失敗しました");
	});
});
