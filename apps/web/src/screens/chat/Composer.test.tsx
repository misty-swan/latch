/**
 * Composer(F6b設計 §1.3)の単体試験。空では送れない・前後の空白を除いて渡す・Ctrl/⌘+Enter
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

const field = () => screen.getByLabelText("メッセージ") as HTMLTextAreaElement;
const sendBtn = () => screen.getByRole("button", { name: "送る" });

describe("Composer", () => {
	it("空白と改行だけでは[送る]がdisabledで・Ctrl+EnterでもonSendを呼ばない", () => {
		const onSend = vi.fn();
		render(<Composer onSend={onSend} />);
		fireEvent.change(field(), { target: { value: "  \n " } });
		expect((sendBtn() as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
		expect(onSend).not.toHaveBeenCalled();
	});

	it("前後の空白を除いた本文を渡し・送信後に空へ戻す", () => {
		const onSend = vi.fn();
		render(<Composer onSend={onSend} />);
		fireEvent.change(field(), { target: { value: "  こんにちは \n" } });
		expect((sendBtn() as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(sendBtn());
		expect(onSend).toHaveBeenCalledWith("こんにちは");
		expect(field().value).toBe("");
		expect((sendBtn() as HTMLButtonElement).disabled).toBe(true);
	});

	it("⌘+Enterで送信する", () => {
		const onSend = vi.fn();
		render(<Composer onSend={onSend} />);
		fireEvent.change(field(), { target: { value: "やあ" } });
		fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
		expect(onSend).toHaveBeenCalledWith("やあ");
	});

	it("Enterだけでは送信しない・maxLengthは2000", () => {
		const onSend = vi.fn();
		render(<Composer onSend={onSend} />);
		fireEvent.change(field(), { target: { value: "やあ" } });
		fireEvent.keyDown(field(), { key: "Enter" });
		expect(onSend).not.toHaveBeenCalled();
		expect(field().maxLength).toBe(2000);
	});
});
