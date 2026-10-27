-- マイグレーション0006(migrations/0006_report_target.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- 通報で足した索引(reports_reporter_latch_id_reportee_target_status_idx)と2列
-- (reports.target・reports.message_id)を撤去する。
-- 注意: 失われる記録は、通報の対象の種別(target)と対象メッセージ(message_id)。

DROP INDEX `reports_reporter_latch_id_reportee_target_status_idx`;
--> statement-breakpoint
ALTER TABLE `reports` DROP COLUMN `target`;
--> statement-breakpoint
ALTER TABLE `reports` DROP COLUMN `message_id`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0006_report_target.sql';
