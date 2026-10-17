import { env } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * マイグレーション適用結果の検証。
 * テーブル集合の正本は docs/05 §2.1(23テーブル)・§2.2(定義)・§2.4(索引)。
 */

/** docs/05 §2.1の23テーブル */
const TABLES = [
	"users",
	"refresh_families",
	"intents",
	"match_events",
	"match_candidates",
	"group_candidates",
	"proposal_history",
	"latches",
	"latch_members",
	"latch_responses",
	"latch_status_events",
	"messages",
	"chat_reads",
	"latch_feedback",
	"blocks",
	"reports",
	"notifications",
	"push_subscriptions",
	"sessions",
	"survey_responses",
	"calibration_records",
	"usage_counters",
	"geofeatures",
] as const;

it("マイグレーション適用後、docs/05 §2.1の23テーブル全てが存在する", async () => {
	const placeholders = TABLES.map(() => "?").join(", ");
	const row = await env.DB.prepare(
		`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
	)
		.bind(...TABLES)
		.first<{ n: number }>();
	expect(row?.n).toBe(23);
});

it("主要UNIQUE INDEXが存在し、想定の列の上に張られている", async () => {
	const uniqueIndexes = [
		{
			name: "users_auth_provider_auth_subject_uniq",
			columns: ["auth_provider", "auth_subject"],
		},
		{
			name: "match_events_event_type_source_intent_id_version_uniq",
			columns: ["event_type", "source_intent_id", "version"],
		},
		{
			name: "proposal_history_user_low_user_high_uniq",
			columns: ["user_low", "user_high"],
		},
	] as const;

	const placeholders = uniqueIndexes.map(() => "?").join(", ");
	const res = await env.DB.prepare(
		`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
	)
		.bind(...uniqueIndexes.map((index) => index.name))
		.all<{ name: string; sql: string | null }>();

	expect(res.results.length).toBe(3);
	for (const index of uniqueIndexes) {
		const found = res.results.find((row) => row.name === index.name);
		expect(found, `${index.name} が存在すること`).toBeDefined();
		for (const column of index.columns) {
			expect(found?.sql, `${index.name} に ${column} を含むこと`).toContain(
				column,
			);
		}
	}
});

it("refresh_families に previous_hash 列と current_hash UNIQUE索引がある(回転猶予・docs/05 §2.2)", async () => {
	// 列の存在(PRAGMAのテーブル名はバインドできないためリテラルで指定)
	const columns = await env.DB.prepare(
		"PRAGMA table_info(refresh_families)",
	).all<{ name: string }>();
	const columnNames = columns.results.map((column) => column.name);
	expect(columnNames, "previous_hash 列が存在すること").toContain(
		"previous_hash",
	);

	// UNIQUE索引の存在と対象列
	const index = await env.DB.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
	)
		.bind("refresh_families_current_hash_uniq")
		.first<{ name: string; sql: string | null }>();
	expect(
		index,
		"refresh_families_current_hash_uniq が存在すること",
	).toBeDefined();
	expect(index?.sql, "current_hash を含むこと").toContain("current_hash");
	expect(index?.sql, "UNIQUE索引であること").toContain("UNIQUE");
});
