/**
 * completed判定の境界の単体試験(F5設計 §2.1)
 */
import { describe, expect, it } from "vitest";
import {
	connectionCompletionCutoff,
	occasionCompletionCutoffIso,
} from "./complete";

describe("completed判定の境界", () => {
	it("つながりの境界はnowの90日前", () => {
		expect(
			connectionCompletionCutoff(
				new Date("2026-06-01T00:00:00Z"),
			).toISOString(),
		).toBe("2026-03-03T00:00:00.000Z");
	});

	it("機会の境界はnowの3時間前のISO 8601(UTC)", () => {
		expect(occasionCompletionCutoffIso(new Date("2026-06-01T03:00:00Z"))).toBe(
			"2026-06-01T00:00:00.000Z",
		);
	});
});
