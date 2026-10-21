/**
 * チャットの入力欄(F6b設計 §1.3)。prototype/app/app.jsのscreens.chatのmountの移植。
 * 高さは内容に合わせ最大140px・Ctrl/⌘+Enterで送信・前後の空白を除いて空なら送れない。
 */

import { LIMITS } from "@latch/shared";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

const MAX_HEIGHT_PX = 140;

export function Composer({ onSend }: { onSend(body: string): void }) {
	const [value, setValue] = useState("");
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const body = value.trim();

	const resizeToContent = () => {
		const el = fieldRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(MAX_HEIGHT_PX, el.scrollHeight)}px`;
	};

	const submit = () => {
		if (body === "") return;
		onSend(body);
		setValue("");
		const el = fieldRef.current;
		if (el) {
			el.value = "";
			resizeToContent();
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
	};

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		submit();
	};

	return (
		<form className="composer" onSubmit={onSubmit}>
			<label className="sr-only" htmlFor="m-text">
				メッセージ
			</label>
			<textarea
				ref={fieldRef}
				className="composer__field"
				id="m-text"
				rows={1}
				maxLength={LIMITS.MESSAGE_BODY_MAX_LENGTH}
				placeholder="メッセージ"
				value={value}
				onChange={(e) => {
					setValue(e.target.value);
					resizeToContent();
				}}
				onKeyDown={onKeyDown}
			/>
			<button
				className="composer__send"
				type="submit"
				aria-label="送る"
				disabled={body === ""}
			>
				<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 18.5V6M6.8 11L12 5.8 17.2 11" />
				</svg>
			</button>
		</form>
	);
}
