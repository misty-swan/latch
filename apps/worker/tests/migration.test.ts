import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import rollback0002Sql from "../migrations_rollback/0002_rollback.sql?raw";
import rollback0003Sql from "../migrations_rollback/0003_rollback.sql?raw";
import rollback0004Sql from "../migrations_rollback/0004_rollback.sql?raw";
import rollback0005Sql from "../migrations_rollback/0005_rollback.sql?raw";

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

/** PRAGMA table_infoの列名一覧(テーブル名はバインドできないためリテラルで渡す) */
async function columnsOf(table: string) {
	const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
		name: string;
		notnull: number;
	}>();
	return result.results;
}

async function indexNamesOf(table: string): Promise<string[]> {
	const result = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{
		name: string;
	}>();
	return result.results.map((index) => index.name);
}

it("0003適用後、提案化の列(from_status null可・proposed_at・updated_at)と4索引が存在する(docs/05 §2.2・§2.4)", async () => {
	const events = await columnsOf("latch_status_events");
	const names = events.map((c) => c.name);
	expect(names).toEqual(
		expect.arrayContaining(["latch_id", "from_status", "to_status"]),
	);
	expect(events.find((c) => c.name === "from_status")?.notnull).toBe(0);
	expect(events.find((c) => c.name === "to_status")?.notnull).toBe(1);

	const latches = await columnsOf("latches");
	const proposedAt = latches.find((c) => c.name === "proposed_at");
	expect(proposedAt, "proposed_at 列が存在すること").toBeDefined();
	expect(proposedAt?.notnull).toBe(0);

	const history = await columnsOf("proposal_history");
	const updatedAt = history.find((c) => c.name === "updated_at");
	expect(updatedAt, "updated_at 列が存在すること").toBeDefined();
	expect(updatedAt?.notnull).toBe(1);

	expect(await indexNamesOf("latches")).toEqual(
		expect.arrayContaining([
			"latches_status_response_deadline_idx",
			"latches_status_proposed_at_idx",
		]),
	);
	expect(await indexNamesOf("notifications")).toContain(
		"notifications_user_id_type_created_at_idx",
	);
	expect(await indexNamesOf("latch_status_events")).toContain(
		"latch_status_events_latch_id_idx",
	);
});

it("戻しマイグレーション0003の適用で追加列・索引が消える(docs/11 §3の対マイグレーション)", async () => {
	for (const statement of toStatements(rollback0003Sql)) {
		await env.DB.prepare(statement).run();
	}
	expect((await columnsOf("latches")).map((c) => c.name)).not.toContain(
		"proposed_at",
	);
	expect(
		(await columnsOf("proposal_history")).map((c) => c.name),
	).not.toContain("updated_at");
	expect(await indexNamesOf("latches")).not.toContain(
		"latches_status_response_deadline_idx",
	);
	expect(await indexNamesOf("notifications")).not.toContain(
		"notifications_user_id_type_created_at_idx",
	);
	expect(await indexNamesOf("latch_status_events")).not.toContain(
		"latch_status_events_latch_id_idx",
	);
	const events = await columnsOf("latch_status_events");
	expect(events.find((c) => c.name === "from_status")?.notnull).toBe(1);
});

it("0004適用後、latch_membersにleft_at列(null可・nullは参加中)がある(F4b設計・docs/05 §2.2)", async () => {
	const members = await columnsOf("latch_members");
	const leftAt = members.find((c) => c.name === "left_at");
	expect(leftAt, "left_at 列が存在すること").toBeDefined();
	expect(leftAt?.notnull).toBe(0);
});

it("戻しマイグレーション0004の適用でleft_at列が消える(docs/11 §3の対マイグレーション)", async () => {
	for (const statement of toStatements(rollback0004Sql)) {
		await env.DB.prepare(statement).run();
	}
	expect((await columnsOf("latch_members")).map((c) => c.name)).not.toContain(
		"left_at",
	);
});

it("0005適用後、latch_membersにhidden_at列(null可・nullは非表示にしていない)がある(F6a設計・docs/05 §2.2)", async () => {
	const members = await columnsOf("latch_members");
	const hiddenAt = members.find((c) => c.name === "hidden_at");
	expect(hiddenAt, "hidden_at 列が存在すること").toBeDefined();
	expect(hiddenAt?.notnull).toBe(0);
});

it("0005適用後、messagesにclient_id列(null可・再送の重複防止用)がある(F6a設計)", async () => {
	const cols = await columnsOf("messages");
	const clientId = cols.find((c) => c.name === "client_id");
	expect(clientId, "client_id 列が存在すること").toBeDefined();
	expect(clientId?.notnull).toBe(0);
});

it("同じ(latch_id, user_id, client_id)の2行目は一意制約で失敗し、client_idがnullの2行は入る", async () => {
	const now = 1_700_000_000_000;
	await env.DB.prepare(
		"INSERT INTO users (id, auth_provider, auth_subject, actor_type, display_name, bio, birth_date, status, created_at, updated_at) VALUES ('U1', 'google', 's1', 'human', 'a', '', '2000-01-01', 'active', ?, ?)",
	)
		.bind(now, now)
		.run();
	await env.DB.prepare(
		"INSERT INTO latches (id, form, intent_ids, proposal, score, status, response_deadline, expires_at, last_message_at, created_at, updated_at) VALUES ('L1', 'connection', '[]', '{}', 0.5, 'matched', ?, ?, ?, ?, ?)",
	)
		.bind(now, now, now, now, now)
		.run();
	const insert = (id: string, clientId: string | null) =>
		env.DB.prepare(
			"INSERT INTO messages (id, latch_id, user_id, body, created_at, client_id) VALUES (?, 'L1', 'U1', 'b', ?, ?)",
		)
			.bind(id, now, clientId)
			.run();
	await insert("M1", "c1");
	await expect(insert("M2", "c1")).rejects.toThrow();
	await insert("M3", null);
	await insert("M4", null);
	expect(await indexNamesOf("messages")).toContain(
		"messages_latch_id_user_id_client_id_uq",
	);
});

it("戻しマイグレーション0005の適用でhidden_at・client_id列と索引が消える(docs/11 §3の対マイグレーション)", async () => {
	for (const statement of toStatements(rollback0005Sql)) {
		await env.DB.prepare(statement).run();
	}
	expect((await columnsOf("latch_members")).map((c) => c.name)).not.toContain(
		"hidden_at",
	);
	expect((await columnsOf("messages")).map((c) => c.name)).not.toContain(
		"client_id",
	);
	expect(await indexNamesOf("messages")).not.toContain(
		"messages_latch_id_user_id_client_id_uq",
	);
});
