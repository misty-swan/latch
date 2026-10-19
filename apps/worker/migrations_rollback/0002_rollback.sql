-- マイグレーション0002(migrations/0002_delayed_reeval_at.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- intentsから遅延再評価の実行済みマーカー列を撤去する(docs/06 §2(h))。

ALTER TABLE `intents` DROP COLUMN `delayed_reeval_at`;
