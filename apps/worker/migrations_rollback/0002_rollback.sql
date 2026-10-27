-- マイグレーション0002(migrations/0002_delayed_reeval_at.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- intentsから遅延再評価の実行済みマーカー列を撤去する(docs/06 §2(h))。

ALTER TABLE `intents` DROP COLUMN `delayed_reeval_at`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0002_delayed_reeval_at.sql';
