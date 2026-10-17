import { defineConfig } from "drizzle-kit";

/**
 * D1マイグレーション生成設定(docs/04 §3.1)。
 * 生成: pnpm --filter worker exec drizzle-kit generate
 * 適用: pnpm --filter worker exec wrangler d1 migrations apply latch-db --local
 */
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/schema.ts",
	out: "./migrations",
});
