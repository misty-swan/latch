import { afterEach, describe, expect, it, vi } from "vitest";
import { markDeferNoteSeen, shouldShowDeferNote } from "./deferNote";

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("deferNote", () => {
	it("初回はtrue・既読にしたformだけfalseになる", () => {
		expect(shouldShowDeferNote("connection")).toBe(true);
		expect(shouldShowDeferNote("occasion")).toBe(true);
		markDeferNoteSeen("connection");
		expect(shouldShowDeferNote("connection")).toBe(false);
		expect(shouldShowDeferNote("occasion")).toBe(true);
		expect(localStorage.getItem("latch.deferNoteSeen.connection")).toBe("1");
	});
	it("localStorageが例外を投げてもtrueを返し・記録は例外を出さない", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(shouldShowDeferNote("occasion")).toBe(true);
		expect(() => markDeferNoteSeen("occasion")).not.toThrow();
	});
});
