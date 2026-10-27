-- マイグレーション0007(migrations/0007_notification_push.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- Web Push記録で足した2索引(notifications_intent_id_type_uniq・
-- notifications_push_state_created_at_idx)と3列(intent_id・push_state・push_attempted_at)を撤去する。
-- 注意: 失われる記録は、Web Pushの送出状態・試行時刻と、intent_expired通知の対象Intent。

DROP INDEX `notifications_intent_id_type_uniq`;
--> statement-breakpoint
DROP INDEX `notifications_push_state_created_at_idx`;
--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `intent_id`;
--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `push_state`;
--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `push_attempted_at`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0007_notification_push.sql';
