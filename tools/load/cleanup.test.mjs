import { describe, expect, it } from "vitest";
import { cleanupSubjects, subjectsWithIntents } from "./cleanup.mjs";

describe("cleanupSubjects", () => {
	it("1人が失敗しても残りの利用者を続けて処理し、件数を合計する", async () => {
		const seen = [];
		const errors = [];
		const result = await cleanupSubjects(
			["load-1", "load-2", "load-3"],
			async (subject) => {
				seen.push(subject);
				if (subject === "load-2") {
					throw new Error(
						"通信エラー https://latch-x.example.workers.dev/v1 で失敗",
					);
				}
				return subject === "load-3"
					? { deleted: 1, failed: 1 }
					: { deleted: 2, failed: 0 };
			},
			(message) => errors.push(message),
		);
		expect(seen).toEqual(["load-1", "load-2", "load-3"]);
		expect(result).toEqual({ deleted: 3, failed: 2, failedUsers: 1 });
		// 誤りの文のURLは伏せる
		expect(errors).toEqual(["通信エラー <url伏せ> で失敗"]);
	});
	it("全員成功なら失敗0件", async () => {
		const result = await cleanupSubjects(["load-1"], async () => ({
			deleted: 4,
			failed: 0,
		}));
		expect(result).toEqual({ deleted: 4, failed: 0, failedUsers: 0 });
	});
	it("利用者がいなければ何もしない", async () => {
		expect(
			await cleanupSubjects([], async () => ({ deleted: 9, failed: 9 })),
		).toEqual({
			deleted: 0,
			failed: 0,
			failedUsers: 0,
		});
	});
});

describe("subjectsWithIntents", () => {
	it("load-で始まるsubjectだけを重複なく返す", () => {
		expect(
			subjectsWithIntents([
				{ auth_subject: "load-1" },
				{ auth_subject: "load-1" },
				{ auth_subject: "user-1" },
				{ auth_subject: null },
				{ auth_subject: "load-2" },
			]),
		).toEqual(["load-1", "load-2"]);
	});
});
