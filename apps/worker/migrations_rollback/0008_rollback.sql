-- マイグレーション0008(migrations/0008_match_events_indexes.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- match_eventsに足した2索引(match_events_source_intent_id_idx・match_events_status_created_at_idx)を撤去する。
-- 注意: データは失われない。戻すと削除APIの子の削除と、Cronの未処理・反映待ちの掃査が全件走査に戻り遅くなる。

DROP INDEX `match_events_source_intent_id_idx`;
--> statement-breakpoint
DROP INDEX `match_events_status_created_at_idx`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0008_match_events_indexes.sql';
