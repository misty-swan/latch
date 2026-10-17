import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// vitest.config.tsが読み込んだマイグレーション(MiniflareのJSONバインディング)を
// テスト実行前に適用する。Setup filesはテストファイル単位の隔離ストレージの外で
// 複数回走り得るが、applyD1Migrations()は未適用分だけを適用するため冪等。
const envWithMigrations = env as typeof env & {
	TEST_MIGRATIONS: D1Migration[];
};
await applyD1Migrations(
	envWithMigrations.DB,
	envWithMigrations.TEST_MIGRATIONS,
);
