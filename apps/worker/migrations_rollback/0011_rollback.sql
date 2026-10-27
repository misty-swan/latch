-- マイグレーション0011(migrations/0011_jev_held.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- Jevの保留の判定し直し(LAT-105)で足したintentsの3列と索引を撤去する。
-- 注意: 保留が残った意思の印が失われ、戻した後は保留を毎分Cronで判定し直さない(次の評価を待つ)。
-- 戻す前に判定し直しを行う版のWorkerを先に戻しておく。

DROP INDEX `intents_status_jev_held_at_idx`;
--> statement-breakpoint
ALTER TABLE `intents` DROP COLUMN `jev_held_count`;
--> statement-breakpoint
ALTER TABLE `intents` DROP COLUMN `jev_held_reason`;
--> statement-breakpoint
ALTER TABLE `intents` DROP COLUMN `jev_held_at`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0011_jev_held.sql';
