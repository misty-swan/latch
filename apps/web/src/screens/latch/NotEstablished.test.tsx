/** NotEstablished画面の単体試験 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NotEstablished } from "./NotEstablished";

afterEach(cleanup);

const view = (variant: "closed" | "ended" | "not_found") =>
	render(
		<MemoryRouter>
			<NotEstablished variant={variant} />
		</MemoryRouter>,
	);

describe("NotEstablished", () => {
	it("closedの見出しと本文", () => {
		view("closed");
		expect(screen.getByRole("heading").textContent).toBe(
			"この提案は成立しませんでした。",
		);
		expect(
			screen.getByText("あなたの意思は、そのまま預けています。"),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "預けている一覧へ" })).toBeTruthy();
	});
	it("endedの見出し", () => {
		view("ended");
		expect(screen.getByRole("heading").textContent).toBe(
			"このつながりは終了しました。",
		);
	});
	it("noticeを渡すとalertとして出し・無ければ出さない", () => {
		render(
			<MemoryRouter>
				<NotEstablished
					variant="closed"
					notice="この提案には、もう回答できません。"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"この提案には、もう回答できません。",
		);
		cleanup();
		view("closed");
		expect(screen.queryByRole("alert")).toBeNull();
	});
	it("not_foundは見出しだけで本文が無い", () => {
		view("not_found");
		expect(screen.getByRole("heading").textContent).toBe(
			"この提案は見つかりませんでした。",
		);
		expect(
			screen.queryByText("あなたの意思は、そのまま預けています。"),
		).toBeNull();
	});
	it("endedでchatToがあれば[チャットを見る]を預けている一覧への上に出す", () => {
		render(
			<MemoryRouter>
				<NotEstablished variant="ended" chatTo="/latches/L1/chat" />
			</MemoryRouter>,
		);
		const chat = screen.getByRole("link", { name: "チャットを見る" });
		expect(chat.getAttribute("href")).toBe("/latches/L1/chat");
		expect(chat.className).toContain("btn--primary");
		expect(chat.className).toContain("btn--block");
		const home = screen.getByRole("link", { name: "預けている一覧へ" });
		expect(
			chat.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
	it("chatToが無いendedや成立しなかった・見つからないではチャットを出さない", () => {
		render(
			<MemoryRouter>
				<NotEstablished variant="ended" />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("link", { name: "チャットを見る" })).toBeNull();
		cleanup();
		render(
			<MemoryRouter>
				<NotEstablished variant="closed" chatTo="/latches/L1/chat" />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("link", { name: "チャットを見る" })).toBeNull();
		cleanup();
		render(
			<MemoryRouter>
				<NotEstablished variant="not_found" chatTo="/latches/L1/chat" />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("link", { name: "チャットを見る" })).toBeNull();
	});
});
