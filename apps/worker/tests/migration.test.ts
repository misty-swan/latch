import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import rollback0002Sql from "../migrations_rollback/0002_rollback.sql?raw";

/**
 * マイグレーション適用結果の検証。
 * テーブル集合の正本は docs/05 §2.1(23テーブル)・§2.2(定義)・§2.4(索引)。
 */

/**
 * SQL文字列を実行文の配列に分解する。
 * D1のexec()は行単位で文を解釈するためコメント行があると落ちる。
 * そこでコメント行を除いた上でセミコロンで分割し、prepare().run()で1文ずつ適用する。
 */
function toStatements(sql: string): string[] {
	const withoutComments = sql
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n");
	return withoutComments
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

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

it("intents に delayed_reeval_at 列がある(active化後10分の1回きり遅延再評価の実行済みマーカー・docs/06 §2(h))", async () => {
	// 列の存在(PRAGMAのテーブル名はバインドできないためリテラルで指定)
	const columns = await env.DB.prepare("PRAGMA table_info(intents)").all<{
		name: string;
		type: string;
		notnull: number;
	}>();
	const column = columns.results.find(
		(column) => column.name === "delayed_reeval_at",
	);
	expect(column, "delayed_reeval_at 列が存在すること").toBeDefined();
	expect(
		column?.type.toLowerCase(),
		"timestamp_ms(integer)型であること(PRAGMAは型名を大文字で返す)",
	).toBe("integer");
	expect(column?.notnull, "null許容(未実行はnull)であること").toBe(0);
});

it("戻しマイグレーション適用で intents の delayed_reeval_at 列が消える(docs/11 §3の対マイグレーション)", async () => {
	for (const statement of toStatements(rollback0002Sql)) {
		await env.DB.prepare(statement).run();
	}

	const columns = await env.DB.prepare("PRAGMA table_info(intents)").all<{
		name: string;
	}>();
	const columnNames = columns.results.map((column) => column.name);
	expect(columnNames).not.toContain("delayed_reeval_at");
});
