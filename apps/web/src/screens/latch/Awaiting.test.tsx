/** Awaiting画面(表示のみ)の単体試験 */

import type { LatchDTO } from "@latch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awaiting } from "./Awaiting";

const NOW = new Date("2026-10-20T03:00:00.000Z");
const latch = {
	id: "l1",
	form: "occasion",
	status: "proposed",
	response_deadline: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
	participants_count: 2,
	my_response: "yes",
	score: 0.5,
	my_intent_id: "i1",
	matched_at: null,
} as LatchDTO;

// 画面は親のnowと実時計の新しい方を使うため・時計をNOWに固定する
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Awaiting", () => {
	it("見出し・期限・回答を取り消すだけで、参加するは無い", () => {
		const onRetract = vi.fn();
		render(
			<MemoryRouter>
				<Awaiting
					latch={latch}
					now={NOW}
					busy={false}
					notice={null}
					onRetract={onRetract}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("heading").textContent).toBe(
			"相手の回答を待っています。",
		);
		expect(screen.getByText("回答期限")).toBeTruthy();
		expect(screen.getByText("あと3分")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "参加する" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "回答を取り消す" }));
		expect(onRetract).toHaveBeenCalledTimes(1);
	});

	it("busy中は取り消しがdisabled", () => {
		render(
			<MemoryRouter>
				<Awaiting
					latch={latch}
					now={NOW}
					busy
					notice={null}
					onRetract={vi.fn()}
				/>
			</MemoryRouter>,
		);
		expect(
			(
				screen.getByRole("button", {
					name: "回答を取り消す",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});
