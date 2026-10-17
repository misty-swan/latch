-- マイグレーション0001(migrations/0001_refresh_rotation.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- refresh_familiesから回転猶予用のprevious_hash列とcurrent_hash UNIQUE索引を撤去する。
-- 列が索引から参照されている間はDROP COLUMNできないため、先に索引を落とす。

DROP INDEX IF EXISTS `refresh_families_current_hash_uniq`;
ALTER TABLE `refresh_families` DROP COLUMN `previous_hash`;
