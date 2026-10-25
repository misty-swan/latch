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

// 第1段のupsertのやり直しの待ち(本番は1秒・2秒)は試験では待たない(#44)。
// やり直し自体の試験は runEmbeddingStage の upsertRetryDelaysMs で個別に指定する
const { setStage1UpsertRetryDelaysForTest } = await import(
	"../src/pipeline/consumer"
);
setStage1UpsertRetryDelaysForTest([0, 0]);
