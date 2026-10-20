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

	it.each([
		["いまは余裕がない", "no_capacity"],
		["日時や場所が合わない", "schedule_mismatch"],
		["なんとなく、今回は", "just_not_now"],
		["その他", "other"],
	])(
		"理由「%s」を残すと%sで保存・トースト表示・導線が消える",
		async (label, value) => {
			vi.useFakeTimers();
			const onSave = view("connection");
			fireEvent.click(
				screen.getByRole("button", { name: /見送った理由を残す/ }),
			);
			const keep = screen.getByRole("button", {
				name: "残す",
			}) as HTMLButtonElement;
			expect(keep.disabled).toBe(true);
			fireEvent.click(screen.getByLabelText(label));
			expect(keep.disabled).toBe(false);
			await act(async () => {
				fireEvent.click(keep);
			});
			expect(onSave).toHaveBeenCalledWith(value);
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
		},
	);

	it("保存が失敗したらシートを開いたまま・トーストは出さず・失敗を知らせる", async () => {
		const onSave = view(
			"connection",
			vi.fn().mockRejectedValue(new Error("x")),
		);
		fireEvent.click(screen.getByRole("button", { name: /見送った理由を残す/ }));
		fireEvent.click(screen.getByLabelText("その他"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "残す" }));
		});
		expect(onSave).toHaveBeenCalledWith("other");
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"送れませんでした。もう一度お試しください。",
		);
		expect(
			screen.queryByText("ありがとうございます。相手には伝わりません。"),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: /見送った理由を残す/ }),
		).toBeTruthy();
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
