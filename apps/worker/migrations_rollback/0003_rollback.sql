-- マイグレーション0003(migrations/0003_latch_proposal.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- 提案化で足した索引4本・列(latches.proposed_at・proposal_history.updated_at)を撤去し、
-- latch_status_events.from_statusをNOT NULLへ戻す。
-- 注意: from_statusがnullの行(生成時の最初の遷移)は、戻す際に空文字へ置き換える。

DROP INDEX `latch_status_events_latch_id_idx`;
DROP INDEX `latches_status_response_deadline_idx`;
DROP INDEX `latches_status_proposed_at_idx`;
DROP INDEX `notifications_user_id_type_created_at_idx`;
ALTER TABLE `latches` DROP COLUMN `proposed_at`;
ALTER TABLE `proposal_history` DROP COLUMN `updated_at`;
CREATE TABLE `__old_latch_status_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`created_at` integer NOT NULL
);
INSERT INTO `__old_latch_status_events`("id", "latch_id", "from_status", "to_status", "created_at") SELECT "id", "latch_id", coalesce("from_status", ''), "to_status", "created_at" FROM `latch_status_events`;
DROP TABLE `latch_status_events`;
ALTER TABLE `__old_latch_status_events` RENAME TO `latch_status_events`;
