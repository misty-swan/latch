/**
 * 提案〜成立の画面で共有する絵の部品の単体試験(F4c設計 §共通の絵)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, DomeRest, GroupDisc, LatchArt, Tategaki } from "./art";

afterEach(cleanup);

describe("GroupDisc", () => {
	it("count=4はpathが4本で、自分のぶん1本だけg-mineになる", () => {
		const { container } = render(<GroupDisc count={4} size={200} />);
		expect(container.querySelectorAll("path")).toHaveLength(4);
		expect(container.querySelectorAll("path.g-mine")).toHaveLength(1);
		expect(container.querySelectorAll("path.g-blank")).toHaveLength(3);
	});

	it("fills指定時は全てg-mineで各色が入る", () => {
		const fills = ["#111", "#222", "#333", "#444"];
		const { container } = render(
			<GroupDisc count={4} size={200} fills={fills} />,
		);
		const paths = container.querySelectorAll("path");
		expect(container.querySelectorAll("path.g-mine")).toHaveLength(4);
		expect(paths[2]?.getAttribute("style")).toContain("fill");
		expect([...paths].map((p) => p.style.fill)).toEqual(fills);
	});

	it("lightでgroup-lightが入る", () => {
		const { container } = render(<GroupDisc count={3} size={200} light />);
		expect(container.querySelector(".group-light")).not.toBeNull();
	});
});

describe("Tategaki", () => {
	it("aria-labelは改行を除いた全文になる", () => {
		render(<Tategaki text={"そっと、\n棚に戻しました。"} />);
		expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
			"そっと、棚に戻しました。",
		);
	});

	it("1文字ずつchで、--iは改行をまたいで連番になる", () => {
		const { container } = render(<Tategaki text={"ab\ncd"} />);
		const chars = container.querySelectorAll(".ch");
		expect(chars).toHaveLength(4);
		expect((chars[3] as HTMLElement).style.getPropertyValue("--i")).toBe("3");
		expect(container.querySelectorAll("br")).toHaveLength(1);
	});
});

describe("Avatar", () => {
	it("hasIcon=falseはimgを含まず、toneのクラスが付く", () => {
		const { container } = render(<Avatar hasIcon={false} size="m" tone="c" />);
		expect(container.querySelector("img")).toBeNull();
		expect(
			container.querySelector(".avatar.avatar--c.avatar--m"),
		).not.toBeNull();
	});

	it("hasIconはicon URLのimgを.avatar内に置く", () => {
		const { container } = render(
			<Avatar userId="u1" hasIcon size="s" tone="b" />,
		);
		expect(container.querySelector(".avatar img")?.getAttribute("src")).toBe(
			"/v1/users/u1/icon",
		);
	});
});

describe("LatchArt / DomeRest", () => {
	it("状態クラス・ring・内側構造を持つ", () => {
		const { container } = render(
			<LatchArt state="latched" size={196} gap={18} ring />,
		);
		const el = container.querySelector(".latch") as HTMLElement;
		expect(el.classList.contains("is-latched")).toBe(true);
		expect(el.getAttribute("aria-hidden")).toBe("true");
		expect(el.style.getPropertyValue("--size")).toBe("196px");
		expect(el.firstElementChild?.classList.contains("latch__ring")).toBe(true);
		expect(el.querySelector(".latch__theirs > .latch__ink")).not.toBeNull();
	});

	it("DomeRestはdomeとshelfを持つ", () => {
		const { container } = render(<DomeRest size={150} />);
		expect(
			container.querySelector(".dome-rest > .dome + .shelf"),
		).not.toBeNull();
	});
});
