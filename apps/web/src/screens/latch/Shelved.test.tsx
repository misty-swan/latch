/** Shelved画面(表示のみ)の単体試験 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shelved } from "./Shelved";

const view = (
	form: "connection" | "occasion",
	onSaveReason = vi.fn().mockResolvedValue(undefined),
) => {
	render(
		<MemoryRouter>
			<Shelved form={form} onSaveReason={onSaveReason} />
		</MemoryRouter>,
	);
	return onSaveReason;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Shelved", () => {
	it("つながりでは今後届かない説明を出す", () => {
		view("connection");
		expect(screen.getByText("この相手との提案は今後届きません。")).toBeTruthy();
	});

	it("機会では条件が変われば届く説明を出す", () => {
		view("occasion");
		expect(
			screen.getByText("条件が変われば、また届くことがあります。"),
		).toBeTruthy();
	});

	it("同じformの2回目のmountでは説明が無く・1回目は再描画で消えない", () => {
		view("connection");
		expect(screen.getByText("この相手との提案は今後届きません。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /見送った理由を残す/ }));
		expect(screen.getByText("この相手との提案は今後届きません。")).toBeTruthy();
		cleanup();
		view("connection");
		expect(screen.queryByText("この相手との提案は今後届きません。")).toBeNull();
	});

	it("理由を選んで残すと保存・トースト表示・導線が消える", async () => {
		vi.useFakeTimers();
		const onSave = view("connection");
		fireEvent.click(screen.getByRole("button", { name: /見送った理由を残す/ }));
		const keep = screen.getByRole("button", {
			name: "残す",
		}) as HTMLButtonElement;
		expect(keep.disabled).toBe(true);
		fireEvent.click(screen.getByLabelText("日時や場所が合わない"));
		expect(keep.disabled).toBe(false);
		await act(async () => {
			fireEvent.click(keep);
		});
		expect(onSave).toHaveBeenCalledWith("schedule_mismatch");
		expect(screen.getByRole("status").textContent).toBe(
			"ありがとうございます。相手には伝わりません。",
		);
		expect(
			screen.queryByRole("button", { name: /見送った理由を残す/ }),
		).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		act(() => {
			vi.advanceTimersByTime(2400);
		});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("スキップは保存せず閉じるだけ", () => {
		const onSave = view("occasion");
		fireEvent.click(screen.getByRole("button", { name: /見送った理由を残す/ }));
		fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.getByRole("button", { name: /見送った理由を残す/ }),
		).toBeTruthy();
	});
});
