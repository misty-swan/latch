/** Matched画面(表示のみ)の単体試験 */

import type { LatchDTO } from "@latch/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Matched } from "./Matched";

const NOW = new Date("2026-10-20T03:00:00.000Z");
// 2026-10-20 9:05 JST
const MATCHED_AT = "2026-10-20T00:05:00.000Z";

const base = {
	id: "l1",
	status: "matched",
	response_deadline: NOW.toISOString(),
	participants_count: 2,
	my_response: "yes",
	score: 0.5,
	my_intent_id: "i1",
	matched_at: MATCHED_AT,
} as const;

const connection = (bio: string | null = "iPadで落書きしています。") =>
	({
		...base,
		form: "connection",
		proposal: {
			form: "connection",
			topic: "イラスト仲間",
			time_window: null,
			region_name: null,
			participants: { min: 2, max: 2 },
			budget: null,
		},
		members: [{ user_id: "u2", display_name: "ひなた", bio, has_icon: false }],
	}) as unknown as LatchDTO;

const occasion = (budget: { min: number; max: number } | null) =>
	({
		...base,
		form: "occasion",
		proposal: {
			form: "occasion",
			topic: "ごはん",
			time_window: {
				start: "2026-10-21T10:00:00.000Z",
				end: "2026-10-21T13:00:00.000Z",
			},
			region_name: null,
			participants: { min: 2, max: 2 },
			budget,
		},
		members: [
			{ user_id: "u2", display_name: "ひなた", bio: null, has_icon: false },
		],
	}) as unknown as LatchDTO;

const view = (latch: LatchDTO, fresh = false) =>
	render(
		<MemoryRouter>
			<Matched latch={latch} now={NOW} fresh={fresh} />
		</MemoryRouter>,
	);

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Matched", () => {
	it("1対1で表示名・自己紹介・成立時刻・重なったところを出す", () => {
		view(connection());
		expect(screen.getByText("ひなた")).toBeTruthy();
		expect(screen.getByText("iPadで落書きしています。")).toBeTruthy();
		expect(screen.getByText("10月20日 9:05 につながりました")).toBeTruthy();
		expect(screen.getByText("2人")).toBeTruthy();
		expect(screen.getByText("指定なし(全国)")).toBeTruthy();
		expect(screen.queryByText("メッセージを送る")).toBeNull();
		expect(screen.getByRole("link", { name: "あとで" })).toBeTruthy();
	});

	it("1対1は相手の色を--theirs-fillに渡す", () => {
		const { container } = view(connection());
		const art = container.querySelector(".latch") as HTMLElement;
		expect(art.style.getPropertyValue("--theirs-fill")).toBe("#6B4E2E");
	});

	it("bioがnullなら自己紹介の段落が無い", () => {
		const { container } = view(connection(null));
		expect(container.querySelector(".partner__bio")).toBeNull();
	});

	it("機会の予算は上限を円で出し・nullなら指定なし", () => {
		view(occasion({ min: 0, max: 4000 }));
		expect(screen.getByText("4,000円以内")).toBeTruthy();
		cleanup();
		view(occasion(null));
		expect(screen.getAllByText("指定なし").length).toBeGreaterThan(0);
		expect(screen.queryByText(/円以内/)).toBeNull();
	});

	it("fresh=falseはlatchedの静止", () => {
		const { container } = view(connection());
		expect(container.querySelector(".latch.is-latched")).toBeTruthy();
		expect(container.querySelector(".matched.is-fresh")).toBeNull();
	});

	it("fresh=trueは650ms後にis-latched・さらに1700ms後ににじみが引く", () => {
		vi.useFakeTimers();
		const { container } = view(connection(), true);
		const art = container.querySelector(".latch") as HTMLElement;
		expect(art.classList.contains("is-pressed")).toBe(true);
		act(() => {
			vi.advanceTimersByTime(650);
		});
		expect(art.classList.contains("is-latched")).toBe(true);
		expect(art.classList.contains("is-pressed")).toBe(false);
		expect(art.classList.contains("is-bleeding")).toBe(true);
		act(() => {
			vi.advanceTimersByTime(1700);
		});
		expect(art.classList.contains("is-bleeding")).toBe(false);
	});

	it("グループは全メンバーの名前を出す", () => {
		const l = {
			...connection(),
			participants_count: 3,
			members: [
				{ user_id: "u2", display_name: "ひなた", bio: null, has_icon: false },
				{ user_id: "u3", display_name: "そら", bio: null, has_icon: false },
			],
		} as unknown as LatchDTO;
		const { container } = view(l);
		expect(screen.getByText("ひなた")).toBeTruthy();
		expect(screen.getByText("そら")).toBeTruthy();
		expect(screen.getByText("3人")).toBeTruthy();
		const paths = Array.from(container.querySelectorAll(".group-disc path"));
		expect(paths.map((p) => p.getAttribute("class"))).toEqual([
			"g-mine",
			"g-mine",
			"g-mine",
		]);
		expect(paths.map((p) => (p as SVGElement).style.fill)).toEqual([
			"var(--ink)",
			"#6B4E2E",
			"#2F5A55",
		]);
	});
	it("noticeを渡すとalertとして出す", () => {
		render(
			<MemoryRouter>
				<Matched
					latch={connection()}
					now={NOW}
					fresh={false}
					notice="この提案には、もう回答できません。"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"この提案には、もう回答できません。",
		);
	});
});
