import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadJevGoldset, loadParserGoldset } from "./goldset";

const write = (body: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "goldset-"));
	const path = join(dir, "g.yaml");
	writeFileSync(path, body);
	return path;
};

const parserItem = (id: string, extra = "") => `  - id: ${id}
    raw_text: "週末にボードゲームをしたい"
    now: "2026-11-02T10:00:00+09:00"
    tags: [connection]
    expect:
      form: connection
      topic: ボードゲーム
      alcohol_involved: false
${extra}`;

const fixture = (indent: string, extra = "") =>
	[
		"form: connection",
		"topic: ボードゲーム",
		"softConstraints: [初心者歓迎]",
		"negativeConstraints: []",
		"participantsMin: 2",
		"participantsMax: 4",
		"participantsIncludesOwner: true",
		extra,
	]
		.flatMap((l) => l.split("\n"))
		.filter((l) => l !== "")
		.map((l) => `${indent}${l}`)
		.join("\n");

describe("loadParserGoldset", () => {
	it("正しいYAMLを読む", () => {
		const g = loadParserGoldset(
			write(
				`version: 1\napproved_by_owner: null\nitems:\n${parserItem("conn-001")}`,
			),
		);
		expect(g.version).toBe(1);
		expect(g.approved_by_owner).toBeNull();
		expect(g.items[0]?.expect.topic).toBe("ボードゲーム");
	});

	it("承認日を文字列で受ける", () => {
		const g = loadParserGoldset(
			write(
				`version: 1\napproved_by_owner: "2026-11-05"\nitems:\n${parserItem("a")}`,
			),
		);
		expect(g.approved_by_owner).toBe("2026-11-05");
	});

	it("idの重複はidつきで例外", () => {
		expect(() =>
			loadParserGoldset(
				write(
					`version: 1\napproved_by_owner: null\nitems:\n${parserItem("dup")}${parserItem("dup")}`,
				),
			),
		).toThrow(/dup/);
	});

	it("必須欠け(raw_text)は件のidつきで例外", () => {
		const bad = `  - id: bad-1\n    now: "2026-11-02T10:00:00+09:00"\n    tags: []\n    expect: {}\n`;
		expect(() =>
			loadParserGoldset(
				write(`version: 1\napproved_by_owner: null\nitems:\n${bad}`),
			),
		).toThrow(/bad-1/);
	});

	it("nowが不正な日時なら例外", () => {
		const bad = parserItem("bad-now").replace(
			"2026-11-02T10:00:00+09:00",
			"来週",
		);
		expect(() =>
			loadParserGoldset(
				write(`version: 1\napproved_by_owner: null\nitems:\n${bad}`),
			),
		).toThrow(/bad-now/);
	});
});

describe("loadJevGoldset", () => {
	const pair = (id: string, match = "yes") =>
		`  - id: ${id}\n    match: ${match}\n    a:\n${fixture("      ", "area: 渋谷区")}\n    b:\n${fixture("      ")}\n`;

	it("正しいYAMLを読み、機会の時刻はDateになる", () => {
		const occ = fixture(
			"      ",
			"startsAt: '2026-11-07T19:00:00+09:00'\nendsAt: '2026-11-07T21:00:00+09:00'\nbudgetMin: 3000\nbudgetMax: 5000",
		).replace("form: connection", "form: occasion");
		const body = `version: 1\napproved_by_owner: null\npairs:\n  - id: p1\n    match: no\n    a:\n${occ}\n    b:\n${fixture("      ")}\n`;
		const g = loadJevGoldset(write(body));
		expect(g.pairs[0]?.a.startsAt).toBeInstanceOf(Date);
		expect(g.pairs[0]?.b.startsAt).toBeNull();
		expect(g.pairs[0]?.match).toBe("no");
	});

	it("areaは任意", () => {
		const g = loadJevGoldset(
			write(`version: 1\napproved_by_owner: null\npairs:\n${pair("p1")}`),
		);
		expect(g.pairs[0]?.a.area).toBe("渋谷区");
		expect(g.pairs[0]?.b.area).toBeUndefined();
	});

	it("idの重複・matchの不正は例外", () => {
		expect(() =>
			loadJevGoldset(
				write(
					`version: 1\napproved_by_owner: null\npairs:\n${pair("x")}${pair("x")}`,
				),
			),
		).toThrow(/x/);
		expect(() =>
			loadJevGoldset(
				write(
					`version: 1\napproved_by_owner: null\npairs:\n${pair("m1", "maybe")}`,
				),
			),
		).toThrow(/m1/);
	});
});
