/**
 * activeのIntent作成の条件付き挿入(#32)の書き換えが前提とするSQLの形を固定する試験。
 * routes/intents.ts は drizzle の挿入のSQLを正規表現で `insert into … select … where …` へ
 * 書き換える。drizzleの版の更新でSQLの形が変わると、作成の経路で例外(500)になるため、
 * ここで生成したSQLの形を固定し、原因が一目で分かるように落とす。
 */

import { env } from "cloudflare:test";
import { LIMITS } from "@latch/shared";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { intents } from "../src/db/schema";
import type { Env as WorkerEnv } from "../src/env";
import { toActiveLimitedInsertSql } from "../src/routes/intents";

const db = drizzle((env as unknown as WorkerEnv).DB);
const now = new Date("2026-10-25T12:00:00.000Z");

/** 作成の経路(routes/intents.ts)と同じく、すべての列を指定した挿入(nullを含む) */
const insertQuery = () =>
	db
		.insert(intents)
		.values({
			id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
			userId: "01JBBBBBBBBBBBBBBBBBBBBBBB",
			form: "connection",
			topic: "形の試験",
			category: "学び・語学",
			rawText: "形の試験",
			startsAt: null,
			endsAt: null,
			geoCenterLat: null,
			geoCenterLng: null,
			geoRadiusM: null,
			participantsMin: 2,
			participantsMax: 2,
			participantsIncludesOwner: true,
			budgetMin: null,
			budgetMax: null,
			currency: null,
			hardConstraints: [],
			softConstraints: [],
			negativeConstraints: [],
			visibility: "hidden_until_match",
			notificationLevel: "proposals_only",
			alcoholInvolved: false,
			status: "active",
			version: 1,
			expiresAt: null,
			embeddingModel: null,
			embeddedAt: null,
			lastEvaluatedAt: null,
			vectorDeletedAt: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

const columns = Object.values(getTableColumns(intents));
const columnNames = columns.map((column) => `"${column.name}"`);
/**
 * 作成の経路が指定しない列(drizzleのSQLiteの方言は既定値の無い未指定の列に引数でなく
 * null を出す)。列を足したらここも見直す
 */
const UNSPECIFIED = new Set([
	"delayed_reeval_at",
	"jev_held_at",
	"jev_held_reason",
]);
const placeholders = columns
	.map((column) => (UNSPECIFIED.has(column.name) ? "null" : "?"))
	.join(", ");

describe("activeのIntent作成の条件付き挿入のSQL(#32)", () => {
	it('drizzleの挿入のSQLは `insert into "intents" (全列) values (?…・未指定はnull) returning 全列` の形である', () => {
		const { sql, params } = insertQuery().toSQL();
		expect(sql).toBe(
			`insert into "intents" (${columnNames.join(", ")}) values (${placeholders}) returning ${columnNames.join(", ")}`,
		);
		expect(params).toHaveLength(columnNames.length - UNSPECIFIED.size);
	});

	it("書き換えは values を上限の確認付きの select に置き換え、引数の後ろに利用者のidが1つ加わる", () => {
		const { sql } = insertQuery().toSQL();
		expect(toActiveLimitedInsertSql(sql)).toBe(
			`insert into "intents" (${columnNames.join(", ")}) select ${placeholders} where (select count(*) from "intents" where "user_id" = ? and "status" = 'active') < ${LIMITS.ACTIVE_INTENTS_PER_USER} returning ${columnNames.join(", ")}`,
		);
	});

	it("形が合わないSQLは例外を投げる(誤ったSQLを流さない)", () => {
		expect(() =>
			toActiveLimitedInsertSql('insert into "intents" default values'),
		).toThrow("insert文の形が想定と違います");
	});
});
