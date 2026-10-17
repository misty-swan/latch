-- F0初回マイグレーション(migrations/0000_initial_schema.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- SQLiteでは索引はテーブルと一体のため、DROP TABLEにより全オブジェクトを撤去する。
-- 順序は外部キーの依存で参照される側を後に残す(子テーブルから親テーブルへ)。

DROP TABLE IF EXISTS `calibration_records`;
DROP TABLE IF EXISTS `survey_responses`;
DROP TABLE IF EXISTS `sessions`;
DROP TABLE IF EXISTS `push_subscriptions`;
DROP TABLE IF EXISTS `notifications`;
DROP TABLE IF EXISTS `reports`;
DROP TABLE IF EXISTS `blocks`;
DROP TABLE IF EXISTS `latch_feedback`;
DROP TABLE IF EXISTS `chat_reads`;
DROP TABLE IF EXISTS `messages`;
DROP TABLE IF EXISTS `latch_status_events`;
DROP TABLE IF EXISTS `latch_responses`;
DROP TABLE IF EXISTS `latch_members`;
DROP TABLE IF EXISTS `latches`;
DROP TABLE IF EXISTS `proposal_history`;
DROP TABLE IF EXISTS `group_candidates`;
DROP TABLE IF EXISTS `match_candidates`;
DROP TABLE IF EXISTS `match_events`;
DROP TABLE IF EXISTS `intents`;
DROP TABLE IF EXISTS `refresh_families`;
DROP TABLE IF EXISTS `usage_counters`;
DROP TABLE IF EXISTS `geofeatures`;
DROP TABLE IF EXISTS `users`;
