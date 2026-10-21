-- マイグレーション0005(migrations/0005_chat_hidden_client_id.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- チャットで足した一意索引(messages_latch_id_user_id_client_id_uq)と2列
-- (messages.client_id・latch_members.hidden_at)を撤去する。
-- 注意: 失われる記録は、LATCHを消した印(hidden_at)と再送の重複防止(client_id)。
-- 戻した後は消した印が失われ、非表示にしたLATCHが一覧に再び現れる。

DROP INDEX `messages_latch_id_user_id_client_id_uq`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `client_id`;
--> statement-breakpoint
ALTER TABLE `latch_members` DROP COLUMN `hidden_at`;
